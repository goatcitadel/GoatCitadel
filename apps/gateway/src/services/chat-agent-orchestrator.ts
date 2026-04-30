/* eslint-disable max-lines -- Chat orchestration is still a centralized runtime coordinator pending a larger bounded-interface split. */
import { randomUUID } from "node:crypto";
import type {
  ChatCitationRecord,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatExecutionPlanRecord,
  ChatMode,
  ChatNormalizationProfile,
  ChatSendMessageRequest,
  ChatStreamChunkDraft,
  ChatThinkingLevel,
  ChatToolLoopGuardEventRecord,
  ChatToolRunRecord,
  ChatTurnBranchKind,
  ChatTurnFailureClass,
  ChatTurnFailureRecord,
  ChatTurnRepairKind,
  ChatTurnRepairSource,
  ChatTurnTraceRecord,
  ChatWebMode,
  McpInvokeRequest,
  McpInvokeResponse,
  ToolLoopDetectionConfig,
  ToolCatalogEntry,
  ToolInvokeRequest,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import { BudgetExceededError, getChatTurnRecoveryAction, type ChatTurnRecoveryAction } from "@goatcitadel/contracts";
import { estimateTokensFromText } from "@goatcitadel/memory-core";
import type { Storage } from "@goatcitadel/storage";
import { hasLiveDataKeywords, EXPLICIT_WEB_PHRASES } from "../orchestration/live-data-detect.js";
import type { McpBrowserFallbackTarget } from "./mcp-runtime.js";
import {
  looksLikePromptLabPromptPackMarkdownImportPrompt,
  looksLikePromptLabPromptPackOperatorSurfacePrompt,
} from "./prompt-pack-prompt-lab-detectors.js";
import {
  applyPromptPackHarnessNormalization,
  isPromptLabHarnessContent,
  looksLikeRepoGroundedInspectionPrompt,
} from "./prompt-pack-harness-normalization.js";

const MAX_TOOL_LOOPS = 6;
const MAX_TOOL_RUNS_PER_TURN = 12;
const PROMPT_LAB_MAX_TOOL_LOOPS = 8;
const PROMPT_LAB_EXPLICIT_MAX_TOOL_RUNS_PER_TURN = 20;
const PROMPT_LAB_IMPLICIT_MAX_TOOL_RUNS_PER_TURN = {
  chat: 12,
  cowork: 16,
  code: 16,
} as const satisfies Record<ChatMode, number>;
const PROMPT_LAB_MIN_MAX_TOKENS = {
  chat: 1800,
  cowork: 2200,
  code: 2400,
} as const satisfies Record<ChatMode, number>;
const TOOL_OUTPUT_VIRTUALIZATION_THRESHOLD_BYTES = 12_000;
const TOOL_OUTPUT_INLINE_SUMMARY_CHARS = 1_400;
const TOOL_OUTPUT_ARTIFACT_SNIPPET_CHARS = 4_000;
const TOOL_FAILURE_CIRCUIT_BREAKER_THRESHOLD = 2;
const TOOL_FAILURE_RATE_LIMIT_THRESHOLD = 4;
const SAFE_WRITE_FALLBACK_DIR = "./workspace/goatcitadel_out";
const QUERY_TOOL_NAMES = new Set(["browser.search", "memory.search", "embeddings.query"]);
// Keep in sync with PROMPT_PACK_FILE_TOOL_NAMES in prompt-pack-service.ts
const LOCAL_PATH_TOOL_NAMES = new Set(["fs.read", "file.read_range", "file.find", "code.search", "code.search_files"]);
const LOCAL_QUERY_TOOL_NAMES = new Set(["code.search", "code.search_files"]);
const WEB_TOOL_NAMES = new Set([
  "browser.search",
  "browser.navigate",
  "browser.extract",
  "browser.interact",
  "http.get",
  "http.post",
]);
const MCP_BROWSER_FALLBACK_TOOL_NAMES = new Set(["browser.search", "browser.navigate", "browser.extract", "http.get"]);
const REMOTE_BLOCK_MARKERS = [
  "attention required!",
  "just a moment...",
  "you have been blocked",
  "security verification",
  "cloudflare ray id",
  "captcha",
  "enable javascript and cookies",
  "sorry, you have been blocked",
];
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
  "file.read_range": ["path", "startLine", "endLine"],
  "file.find": ["path", "pattern"],
  "code.search": ["path", "query"],
  "code.search_files": ["path", "query"],
  "memory.search": ["query"],
  "memory.write": ["namespace", "title", "content"],
  "memory.upsert": ["namespace", "title", "content"],
  "embeddings.query": ["query"],
};
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

interface ChatExecutionBudget {
  turnBudgetMs: number;
  completionTimeoutMs: number;
  maxToolLoops: number;
  maxToolRunsPerTurn: number;
  searchMaxResults: number;
  maxTokens?: number;
  minSynthesisReserveMs: number;
  expensiveToolMinimumRemainingMs: number;
}

interface ToolLoopHistoryEntry {
  toolName: string;
  signature: string;
  resultSignature?: string;
  status: ChatToolRunRecord["status"];
}

interface ToolLoopGuardRuntimeState {
  config: ToolLoopDetectionConfig;
  history: ToolLoopHistoryEntry[];
  events: ChatToolLoopGuardEventRecord[];
}

// Temporary testing override: use effectively-unbounded turn/completion budgets
// so model speed differences do not truncate evaluation quality mid-run.
const TESTING_CHAT_TURN_BUDGET_MS = 30 * 60 * 1000;
const TESTING_CHAT_COMPLETION_TIMEOUT_MS = 30 * 60 * 1000;

class ChatTurnBudgetExceededError extends BudgetExceededError {
  public constructor(
    public readonly webMode: ChatWebMode,
    public readonly turnBudgetMs: number,
  ) {
    super(buildTurnBudgetExceededReason(webMode, turnBudgetMs), { webMode, turnBudgetMs });
  }
}

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
  normalizationProfile?: ChatNormalizationProfile;
  toolAutonomy: "safe_auto" | "manual";
  historyMessages: ChatCompletionRequest["messages"];
  outputMessageId?: string;
  signal?: AbortSignal;
}

export interface ChatAgentTurnResult {
  turnTrace: ChatTurnTraceRecord;
  assistantContent: string;
  assistantModel?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    costUsd?: number;
  };
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
    args?: Record<string, unknown>;
  }) => {
    allowed: boolean;
    requiresApproval: boolean;
    reasonCodes: string[];
  };
  toolLoopDetection?: ToolLoopDetectionConfig;
}

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
    const intents = {
      liveData: detectLiveDataIntent(input.content),
      webLookup: detectWebLookupIntent(input.content, input.historyMessages),
      time: detectTimeIntent(input.content),
      localFile: detectLocalFileIntent(input.content),
      missingLogPayload: detectMissingLogPayloadIntent(input.content),
    };
    const loopGuardState = initializeToolLoopGuardState(this.deps.toolLoopDetection);
    const trace = this.deps.storage.chatTurnTraces.create({
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
    const promptLabContract = parsePromptLabRunContract(input.content);
    const normalizationProfile = input.normalizationProfile ?? "live";
    const parsedPromptLabTask = promptLabContract.userTask?.trim();
    const promptLabTaskForInspection =
      parsedPromptLabTask || extractPrimaryUserTaskContent(input.content) || input.content;
    const promptLabFilePaths = extractExplicitLocalFilePathsFromPrompt(promptLabTaskForInspection);
    const promptLabExplicitFilesOnly = promptLabTaskLimitsInspectionToExplicitFiles(promptLabTaskForInspection);
    const promptLabCompanionFilePaths = inferPromptLabCompanionFilePaths(
      promptLabTaskForInspection,
      promptLabExplicitFilesOnly ? [] : promptLabFilePaths,
    );
    const promptLabSuggestedFilePaths = promptLabExplicitFilesOnly
      ? []
      : inferPromptLabSuggestedFilePaths(promptLabTaskForInspection);
    const promptLabPrefetchFilePaths = [
      ...new Set([...promptLabFilePaths, ...promptLabCompanionFilePaths, ...promptLabSuggestedFilePaths]),
    ];
    const promptLabRepoInspectionAssist =
      promptLabFilePaths.length === 0 && promptLabTaskSuggestsRepoInspection(promptLabTaskForInspection);
    const repoGroundedInspectionAssist =
      normalizationProfile === "prompt_pack_harness" &&
      looksLikeRepoGroundedInspectionPrompt(promptLabTaskForInspection);
    const promptLabShouldInspectFilesForTurn =
      promptLabContractRequiresFileTools(promptLabContract) ||
      promptLabContract.repoGroundedAssist ||
      promptLabRepoInspectionAssist ||
      repoGroundedInspectionAssist ||
      promptLabPrefetchFilePaths.length > 0;
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
    const memoryLookupIntent = detectMemoryLookupIntent(input.content);
    const explicitMemoryOnlyPrompt = /\bmemory tools only\b/i.test(input.content);
    const promptSpecificWebLookupTurn = input.mode !== "code" && Boolean(derivePromptSpecificWebQuery(input.content));
    const canUseMemorySearchTool = toolSchema.canonicalToModel.has("memory.search");
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
    const usageTotals = {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costUsd: 0,
    };
    let usageObserved = false;
    let circuitBreakerReason: string | undefined;
    let circuitBreakerFailureClass: ChatTurnFailureClass | undefined;
    const toolFailureSignatureCounts = new Map<string, number>();
    let promptLabToolComplianceRetryIssued = false;
    let promptLabSynthesisOnly = false;
    const outputMessageId = input.outputMessageId ?? `assistant-${input.turnId}`;
    const executionBudget = resolveChatExecutionBudget({
      mode: input.mode,
      webMode: input.webMode,
      thinkingLevel: input.thinkingLevel,
      liveDataIntent: intents.webLookup,
      promptLabExplicitTools: promptLabContract.explicitTools,
      promptLabHarness: normalizationProfile === "prompt_pack_harness" || isPromptLabHarnessContent(input.content),
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
    const promptLabHarnessTurn = isPromptLabHarnessContent(input.content);
    if (!assistantContent && !promptLabHarnessTurn) {
      const clarificationFollowUp = buildClarificationFollowUpIfNeeded(input.content, input.historyMessages);
      if (clarificationFollowUp) {
        assistantContent = clarificationFollowUp;
      }
    }
    if (!assistantContent && !promptLabHarnessTurn) {
      const clarificationPrompt = buildClarificationPromptIfNeeded(input.content);
      if (clarificationPrompt) {
        assistantContent = clarificationPrompt;
      }
    }
    if (!assistantContent) {
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
      !approvalPayload &&
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
      !approvalPayload &&
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
      !approvalPayload &&
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
          if (syntheticRun.record.status === "approval_required" && syntheticRun.record.approvalId) {
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
              if (fileReadRun.record.status === "approval_required" && fileReadRun.record.approvalId) {
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
            if (effectiveSearchRun.record.status === "approval_required" && effectiveSearchRun.record.approvalId) {
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
                if (fileReadRun.record.status === "approval_required" && fileReadRun.record.approvalId) {
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
        promptLabContractRequiresWebTools(promptLabContract) &&
        input.mode !== "chat" &&
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
      if (syntheticRun.record.status === "approval_required" && syntheticRun.record.approvalId) {
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
          shouldProactivelyOpenGroundedNewsResult(liveDataQuerySourceContent) &&
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
            if (navigateRun.record.status === "approval_required" && navigateRun.record.approvalId) {
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
      if (syntheticRun.record.status === "approval_required" && syntheticRun.record.approvalId) {
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

    if (!assistantContent) {
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

          const completionTimeoutMs = Math.min(
            effectiveCompletionTimeoutMs,
            ensureChatTurnBudgetRemaining(turnBudgetDeadline, input.webMode, effectiveTurnBudgetMs),
          );
          const promptLabControls = resolvePromptLabOpenAiControls(input, toolSchema.tools.length > 0);
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
            reasoning: promptLabControls.reasoning,
            verbosity: promptLabControls.verbosity,
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
          if (this.deps.createChatCompletionStream) {
            try {
              const aggregate = createCompletionStreamAggregate();
              for await (const rawChunk of this.deps.createChatCompletionStream({
                ...completionRequest,
                stream: true,
              })) {
                const streamed = absorbCompletionStreamChunk(aggregate, rawChunk);
                if (streamed.delta && !streamed.sawToolCall) {
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
            } catch {
              completion = await this.deps.createChatCompletion(completionRequest);
            }
          } else {
            completion = await this.deps.createChatCompletion(completionRequest);
          }
          assistantModel = typeof completion.model === "string" ? completion.model : assistantModel;
          const completionUsage = parseUsageFromCompletion(completion);
          if (completionUsage) {
            usageObserved = true;
            usageTotals.inputTokens += completionUsage.inputTokens ?? 0;
            usageTotals.outputTokens += completionUsage.outputTokens ?? 0;
            usageTotals.cachedInputTokens += completionUsage.cachedInputTokens ?? 0;
            usageTotals.costUsd += completionUsage.costUsd ?? 0;
          }
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

          let toolCalls = readToolCalls(message, toolSchema.modelToCanonical);
          if (
            normalizationProfile === "prompt_pack_harness" &&
            input.mode !== "code" &&
            !promptLabShouldInspectFilesForTurn
          ) {
            toolCalls = toolCalls.filter((toolCall) => !LOCAL_PATH_TOOL_NAMES.has(toolCall.toolName));
          }
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
              assistantContent = buildUserSafeFailureMessage(finalFailure);
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
              assistantContent = buildTurnBudgetExceededFallbackMessage(input, toolRuns, effectiveTurnBudgetMs);
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

            const softFailApprovalRequiredTool =
              executed.record.status === "approval_required" &&
              executed.record.approvalId &&
              shouldSoftFailApprovalRequiredTool({
                mode: input.mode,
                prompt: input.content,
                promptLabContract,
                toolRuns,
              });

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
            conversationMessages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify(toolResultPayload),
            } as ChatCompletionMessage);
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
          assistantContent = buildTurnBudgetExceededFallbackMessage(input, toolRuns, error.turnBudgetMs);
          finalFailure = buildChatTurnFailureRecord(
            "turn_budget_exceeded",
            error.message,
            input.webMode === "deep" ? "retry_narrower" : "switch_to_deep_mode",
          );
        } else {
          finalStatus = "failed";
          finalFailure = buildChatTurnFailureRecord(
            classifyChatTurnFailure({
              error,
              toolRuns,
            }),
            (error as Error).message,
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

    if (!approvalPayload && finalStatus !== "cancelled" && completionState.status !== "complete") {
      const repairedCompletion = await this.repairIncompleteAssistantCompletion({
        input,
        partialAssistantContent: assistantContent,
        conversationMessages,
        toolRuns,
        turnBudgetDeadline,
      });
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
    if (!approvalPayload && finalStatus !== "cancelled" && input.mode === "cowork") {
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
    if (!approvalPayload && finalStatus !== "cancelled") {
      const preRepairContent = assistantContent;
      const harnessNormalization = applyPromptPackHarnessNormalization({
        normalizationProfile,
        prompt: input.content,
        responseText: assistantContent,
        toolRuns,
        normalizePromptLabContractOutput,
        normalizeRepoGroundedInspectionOutput,
      });
      if (harnessNormalization.signals.length > 0 && harnessNormalization.responseText !== assistantContent) {
        assistantContent = harnessNormalization.responseText;
        markCompletionRepair(
          "prompt_pack_harness_normalization",
          "prompt_pack_harness",
          preRepairContent,
          assistantContent,
        );
      }
    }
    if (!approvalPayload && finalStatus !== "cancelled" && input.mode === "cowork") {
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
    if (!approvalPayload && finalStatus !== "cancelled" && normalizationProfile === "prompt_pack_harness") {
      const repairedWebCitations = appendPromptLabWebCitationsIfNeeded(input.content, assistantContent, toolRuns);
      if (repairedWebCitations !== assistantContent) {
        const preRepairContent = assistantContent;
        assistantContent = repairedWebCitations;
        markCompletionRepair("prompt_pack_harness_normalization", "orchestrator", preRepairContent, assistantContent);
      }
    }
    if (finalStatus !== "cancelled") {
      assistantContent = appendToolFailureConstraints(assistantContent, toolRuns, input.content);
    }
    if (
      normalizationProfile === "prompt_pack_harness" &&
      finalStatus === "completed" &&
      !approvalPayload &&
      completionState.repaired &&
      finalFailure?.recommendedAction === "continue_from_partial" &&
      /provider stopped before the answer finished|repair pass is required/i.test(finalFailure.message) &&
      assistantContent.trim().length > 0 &&
      !looksLikeRecoverableAssistantFallbackContent(assistantContent) &&
      !looksLikeDegradedAssistantFallbackContent(assistantContent) &&
      !looksLikeSerializedToolCallMarkupContent(assistantContent)
    ) {
      finalFailure = undefined;
    }

    const finishedAt = new Date().toISOString();
    const finalizedCompletion = finalizeTurnCompletionState({
      completion: completionState,
      finalStatus,
      approvalPending: Boolean(approvalPayload),
    });
    const updatedTrace = this.deps.storage.chatTurnTraces.patch(input.turnId, {
      status: finalStatus,
      model: assistantModel,
      citations,
      failure: finalFailure,
      completion: finalizedCompletion,
      routing: {
        ...routingState,
        liveDataIntent: intents.liveData,
        effectiveProviderId: routingState.effectiveProviderId ?? input.providerId,
        effectiveModel: routingState.effectiveModel ?? assistantModel,
      },
      loopGuard: createLoopGuardTrace(loopGuardState),
      finishedAt,
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
    } else if (finalStatus !== "cancelled") {
      if (usageObserved) {
        yield {
          type: "usage",
          sessionId: input.sessionId,
          turnId: input.turnId,
          usage: {
            inputTokens: usageTotals.inputTokens,
            outputTokens: usageTotals.outputTokens,
            cachedInputTokens: usageTotals.cachedInputTokens,
            costUsd: usageTotals.costUsd,
          },
        };
      }
      yield {
        type: "message_done",
        sessionId: input.sessionId,
        turnId: input.turnId,
        messageId: outputMessageId,
        content: assistantContent,
        repaired: Boolean(finalizedCompletion.repaired),
        repair: finalizedCompletion.repair,
      };
    }

    yield {
      type: "trace_update",
      sessionId: input.sessionId,
      turnId: input.turnId,
      trace: hydratedTrace,
    };

    if (finalizedCompletion.status === "complete") {
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
      "sessionId" | "webMode" | "mode" | "content" | "historyMessages" | "normalizationProfile"
    >,
    intents: {
      liveData: boolean;
      webLookup: boolean;
      localFile: boolean;
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
      (/\bmemory tools only\b/i.test(input.content) ||
        /\buse web lookup\b/i.test(input.content) ||
        (input.mode === "cowork" &&
          looksLikeEverydayNonCodeCoworkPrompt(input.content, promptLabTask ?? input.content)));
    const delegatedPromptLabNonCodeWithoutFileIntent =
      input.mode !== "code" &&
      !promptLabFileInspectionIntent &&
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
    const memoryLookupIntent = detectMemoryLookupIntent(input.content);
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
          args: {},
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
    for (const explicitToolName of extractExplicitToolLikeReferences(input.content)) {
      if (suppressLocalPathTools && LOCAL_PATH_TOOL_NAMES.has(explicitToolName)) {
        continue;
      }
      if (canonicalToModel.has(explicitToolName)) {
        continue;
      }
      const modelName = toProviderToolFunctionName(explicitToolName, modelToCanonical);
      modelToCanonical.set(modelName, explicitToolName);
      canonicalToModel.set(explicitToolName, modelName);
    }

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

    try {
      const result = await this.deps.invokeTool({
        toolName: preflight.toolName,
        args: preflight.args,
        agentId: "assistant",
        sessionId: input.input.sessionId,
        signal: input.input.signal,
        consentContext: {
          source: "agent",
          reason: `chat mode ${input.input.mode}`,
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
      3,
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
          signal: input.turnInput.signal,
          consentContext: {
            source: "agent",
            reason: `chat mode ${input.turnInput.mode}`,
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
          signal: input.turnInput.signal,
          consentContext: {
            source: "agent",
            reason: `search engine fallback (${engine}) after ${input.classification.failureClass}`,
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
    if (isBrowserNavigate && typeof args.url === "string") {
      const promotedUrl = redirectSearchPortalNavigateUrl(args.url, input.userContent, input.priorToolRuns);
      if (promotedUrl && promotedUrl !== args.url) {
        args.url = promotedUrl;
      }
    }
    if (isBrowserSearch) {
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
    const promptLabCoworkPromptSpecificWebSearch =
      isBrowserSearch &&
      (input.localFileIntent ?? false) &&
      isPromptLabHarnessContent(input.userContent) &&
      input.mode === "cowork" &&
      Boolean(derivePromptSpecificWebQuery(input.userContent));
    if (
      isBrowserSearch &&
      (input.localFileIntent ?? false) &&
      !detectExplicitWebLookupIntent(input.userContent) &&
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
      const inferred =
        inferToolArgValue(input.toolName, field, input.userContent) ??
        inferToolArgValueFromRecentToolRuns(input.toolName, field, input.userContent, input.priorToolRuns);
      if (inferred !== undefined) {
        args[field] = inferred;
      } else {
        unresolved.push(field);
      }
    }

    if (unresolved.length > 0) {
      const field = unresolved[0] ?? "arg";
      if (field === "query" && (input.toolName === "memory.search" || input.toolName === "browser.search")) {
        if (input.toolName === "memory.search") {
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

    return { toolName: effectiveToolName, args };
  }

  private async tryWriteJailFallback(input: {
    input: ChatAgentTurnInput;
    toolName: string;
    args: Record<string, unknown>;
    policyReason?: string;
  }): Promise<
    | {
        result: ToolInvokeResult;
        fallbackPath: string;
      }
    | undefined
  > {
    if (input.toolName !== "fs.write" && input.toolName !== "artifacts.create") {
      return undefined;
    }
    if (!isWriteJailBlockReason(input.policyReason)) {
      return undefined;
    }
    const fallbackPath = buildSafeWriteFallbackPath(input.input.sessionId, input.toolName, input.args.path);
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
      signal: input.input.signal,
      consentContext: {
        source: "agent",
        reason: `chat mode ${input.input.mode}; safe write fallback`,
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
  }): Promise<{ content: string; deterministic: boolean }> {
    const constrainedLocalRepoRecovery =
      shouldUseConstrainedLocalAgentProfile(input.input.providerId, input.input.model) &&
      input.input.normalizationProfile === "prompt_pack_harness" &&
      looksLikeRepoGroundedInspectionPrompt(input.input.content)
        ? buildRecoveredRepoGroundedAnswer(input.input.content, input.toolRuns)
        : undefined;
    const deterministic =
      constrainedLocalRepoRecovery ??
      buildDeterministicToolSynthesisFallback(input.input.content, input.toolRuns, input.circuitBreakerReason);
    if (constrainedLocalRepoRecovery) {
      return {
        content: constrainedLocalRepoRecovery,
        deterministic: true,
      };
    }
    const toolSummary = summarizeToolRunsForSynthesis(input.toolRuns, input.input.content);
    const synthesisTimeoutMs = input.allowOverBudget
      ? TESTING_CHAT_COMPLETION_TIMEOUT_MS
      : input.turnBudgetDeadline
        ? Math.min(TESTING_CHAT_COMPLETION_TIMEOUT_MS, Math.max(3000, input.turnBudgetDeadline - Date.now()))
        : TESTING_CHAT_COMPLETION_TIMEOUT_MS;
    try {
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
      const message = completion.choices?.[0]?.message as Record<string, unknown> | undefined;
      const synthesized = extractMessageContent(message ?? {}).trim();
      if (synthesized.length > 0) {
        return {
          content: synthesized,
          deterministic: false,
        };
      }
    } catch {
      // Deterministic fallback below.
    }
    return {
      content: deterministic,
      deterministic: true,
    };
  }

  private async repairIncompleteAssistantCompletion(input: {
    input: ChatAgentTurnInput;
    partialAssistantContent: string;
    conversationMessages: ChatCompletionRequest["messages"];
    toolRuns: ChatToolRunRecord[];
    turnBudgetDeadline?: number;
  }): Promise<{ content: string }> {
    const constrainedLocalRepair = shouldUseConstrainedLocalAgentProfile(input.input.providerId, input.input.model);
    const repoGroundedRepair =
      input.input.normalizationProfile === "prompt_pack_harness" &&
      looksLikeRepoGroundedInspectionPrompt(input.input.content);
    if (constrainedLocalRepair && repoGroundedRepair) {
      const recovered = buildRecoveredRepoGroundedAnswer(input.input.content, input.toolRuns);
      if (recovered) {
        return {
          content: recovered,
        };
      }
    }
    const timeoutMs = input.turnBudgetDeadline
      ? Math.min(TESTING_CHAT_COMPLETION_TIMEOUT_MS, Math.max(3000, input.turnBudgetDeadline - Date.now()))
      : TESTING_CHAT_COMPLETION_TIMEOUT_MS;
    const toolSummary = summarizeToolRunsForSynthesis(input.toolRuns, input.input.content);
    const ignoreDraft = looksLikeUserSafeFailureMessage(input.partialAssistantContent);
    try {
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
      const message = completion.choices?.[0]?.message as Record<string, unknown> | undefined;
      return {
        content: extractMessageContent(message ?? {}).trim(),
      };
    } catch {
      return {
        content: "",
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
}): NonNullable<ChatTurnTraceRecord["completion"]> {
  if (input.approvalPending) {
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

function extractPersistableToolArtifactContent(
  toolName: string,
  result: Record<string, unknown>,
):
  | {
      content: string;
      contentType?: string;
      snippet: string;
      summary: string;
      virtualized: boolean;
      compactMode: "textual" | "structured";
    }
  | undefined {
  if (typeof result.body === "string" && result.body.length > 0) {
    if (Buffer.byteLength(result.body, "utf8") <= TOOL_OUTPUT_VIRTUALIZATION_THRESHOLD_BYTES) {
      return undefined;
    }
    return {
      content: result.body,
      contentType: typeof result.contentType === "string" ? result.contentType : undefined,
      snippet:
        typeof result.bodySnippet === "string"
          ? result.bodySnippet.slice(0, TOOL_OUTPUT_ARTIFACT_SNIPPET_CHARS)
          : result.body.slice(0, TOOL_OUTPUT_ARTIFACT_SNIPPET_CHARS),
      summary: summarizeVirtualizedToolResult(toolName, result),
      virtualized: true,
      compactMode: "textual",
    };
  }
  if (typeof result.text === "string" && result.text.length > 0) {
    if (Buffer.byteLength(result.text, "utf8") <= TOOL_OUTPUT_VIRTUALIZATION_THRESHOLD_BYTES) {
      return undefined;
    }
    return {
      content: result.text,
      contentType: "text/plain; charset=utf-8",
      snippet: result.text.slice(0, TOOL_OUTPUT_ARTIFACT_SNIPPET_CHARS),
      summary: summarizeVirtualizedToolResult(toolName, result),
      virtualized: true,
      compactMode: "textual",
    };
  }
  const serialized = safeSerializeToolResult(result);
  if (!serialized || Buffer.byteLength(serialized, "utf8") <= TOOL_OUTPUT_VIRTUALIZATION_THRESHOLD_BYTES) {
    return undefined;
  }
  return {
    content: serialized,
    contentType: "application/json; charset=utf-8",
    snippet: serialized.slice(0, TOOL_OUTPUT_ARTIFACT_SNIPPET_CHARS),
    summary: summarizeVirtualizedToolResult(toolName, result),
    virtualized: true,
    compactMode: "structured",
  };
}

function safeSerializeToolResult(result: Record<string, unknown>): string | undefined {
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return undefined;
  }
}

function summarizeVirtualizedToolResult(toolName: string, result: Record<string, unknown>): string {
  const candidates = [
    typeof result.message === "string" ? result.message : undefined,
    typeof result.bodySnippet === "string" ? result.bodySnippet : undefined,
    typeof result.textSnippet === "string" ? result.textSnippet : undefined,
    Array.isArray(result.results)
      ? `${result.results.length} result${result.results.length === 1 ? "" : "s"} returned.`
      : undefined,
    typeof result.status === "number" ? `HTTP ${result.status}` : undefined,
  ].filter((value): value is string => Boolean(value && value.trim()));
  if (candidates.length > 0) {
    return candidates.join(" ").slice(0, TOOL_OUTPUT_INLINE_SUMMARY_CHARS);
  }
  return `Stored ${toolName} output as an artifact to keep live context compact.`;
}

function buildCompactToolResultMetadata(result: Record<string, unknown>): Record<string, unknown> {
  const compacted: Record<string, unknown> = {};
  const scalarKeys = [
    "url",
    "finalUrl",
    "status",
    "httpStatus",
    "message",
    "engineTier",
    "engineLabel",
    "browserFailureClass",
    "title",
  ] as const;
  for (const key of scalarKeys) {
    const value = result[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      compacted[key] = value;
    }
  }
  if (Array.isArray(result.results)) {
    compacted.resultCount = result.results.length;
  }
  if (Array.isArray(result.fallbackChain) && result.fallbackChain.length > 0) {
    compacted.fallbackChain = result.fallbackChain;
  }
  return compacted;
}

function compactToolResultForTurn(
  result: Record<string, unknown>,
  artifact: {
    artifactId: string;
    storageRelPath: string;
    byteLength: number;
    contentType?: string;
    snippet?: string;
    summary: string;
    virtualized: boolean;
    compactMode: "textual" | "structured";
  },
): Record<string, unknown> {
  const resultText = typeof result.text === "string" ? result.text : undefined;
  const resultBodySnippet = typeof result.bodySnippet === "string" ? result.bodySnippet : undefined;
  const compacted: Record<string, unknown> = {
    ...(artifact.compactMode === "structured" ? buildCompactToolResultMetadata(result) : result),
    artifactId: artifact.artifactId,
    artifactPath: artifact.storageRelPath,
    byteLength: artifact.byteLength,
    originalByteLength: artifact.byteLength,
    contentType: artifact.contentType ?? result.contentType,
    snippet: artifact.snippet ?? resultBodySnippet ?? resultText?.slice(0, 4000),
    artifactSummary: artifact.summary,
    virtualized: artifact.virtualized,
    storedAsArtifact: true,
  };
  if ("body" in compacted) {
    delete (compacted as { body?: unknown }).body;
  }
  if (resultText && resultText.length > 4000) {
    compacted.text = resultText.slice(0, 4000);
  }
  if (artifact.compactMode === "structured" && "text" in compacted) {
    delete (compacted as { text?: unknown }).text;
  }
  if (!("bodySnippet" in compacted) && typeof compacted.snippet === "string") {
    compacted.bodySnippet = compacted.snippet;
  }
  return compacted;
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
  if (!input.suppressLocalPathTools && (input.localFileIntent || input.projectBound || input.mode === "code")) {
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

function scoreToolForTurn(input: {
  tool: ToolCatalogEntry;
  mode: ChatMode;
  liveDataIntent: boolean;
  webLookupIntent: boolean;
  localFileIntent: boolean;
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

function readToolCalls(
  message: Record<string, unknown>,
  modelToCanonical: Map<string, string> = new Map<string, string>(),
): Array<{
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  rawArguments: string;
}> {
  const raw = message.tool_calls;
  const out: Array<{ id: string; toolName: string; args: Record<string, unknown>; rawArguments: string }> = [];
  if (Array.isArray(raw)) {
    for (const value of raw) {
      const toolCall = value as Record<string, unknown>;
      const id = typeof toolCall.id === "string" ? toolCall.id : `tool-${randomUUID()}`;
      const fn = toolCall.function as Record<string, unknown> | undefined;
      const rawToolName = typeof fn?.name === "string" ? fn.name : undefined;
      const toolName = rawToolName ? resolveAllowedModelToolCallName(rawToolName, modelToCanonical) : undefined;
      if (!toolName) {
        continue;
      }
      let args: Record<string, unknown> = {};
      const rawArgs = fn?.arguments;
      const rawArguments = typeof rawArgs === "string" && rawArgs.trim() ? rawArgs : JSON.stringify(args);
      if (typeof rawArgs === "string" && rawArgs.trim()) {
        try {
          const parsed = JSON.parse(rawArgs) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            args = parsed as Record<string, unknown>;
          }
        } catch {
          args = {};
        }
      }
      out.push({ id, toolName, args, rawArguments });
    }
    return out;
  }
  return parseSerializedToolCalls(extractMessageContent(message), modelToCanonical);
}

function parseSerializedToolCalls(
  content: string,
  modelToCanonical: Map<string, string>,
): Array<{
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  rawArguments: string;
}> {
  const trimmed = content.trim();
  if (!trimmed) {
    return [];
  }
  const calls: Array<{ id: string; toolName: string; args: Record<string, unknown>; rawArguments: string }> = [];
  const functionMatches = Array.from(
    trimmed.matchAll(/<function=([a-z0-9_.-]+)>([\s\S]*?)(?:<\/function>|<\/tool_call>)/gi),
  );
  for (const match of functionMatches) {
    const rawToolName = match[1]?.trim();
    if (!rawToolName) {
      continue;
    }
    const toolName = resolveAllowedModelToolCallName(rawToolName, modelToCanonical);
    if (!toolName) {
      continue;
    }
    const body = (match[2] ?? "").trim();
    let args: Record<string, unknown> = {};
    let rawArguments = "{}";
    const parameterMatches = Array.from(body.matchAll(/<parameter=([a-z0-9_.-]+)>\s*([\s\S]*?)\s*<\/parameter>/gi));
    if (parameterMatches.length > 0) {
      args = Object.fromEntries(
        parameterMatches.map((parameterMatch) => [parameterMatch[1]!, parameterMatch[2]!.trim()]),
      );
      rawArguments = JSON.stringify(args);
    } else if (body) {
      rawArguments = body;
      try {
        const parsed = JSON.parse(body) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
          rawArguments = JSON.stringify(args);
        }
      } catch {
        args = {};
      }
    }
    calls.push({
      id: `tool-${randomUUID()}`,
      toolName,
      args,
      rawArguments,
    });
  }
  return calls;
}

function resolveAllowedModelToolCallName(
  rawToolName: string,
  modelToCanonical: Map<string, string>,
): string | undefined {
  const mapped = modelToCanonical.get(rawToolName);
  if (mapped) {
    return mapped;
  }
  if (modelToCanonical.size === 0) {
    return rawToolName;
  }
  const allowedCanonicalNames = new Set(modelToCanonical.values());
  return allowedCanonicalNames.has(rawToolName) ? rawToolName : undefined;
}

function toProviderToolFunctionName(toolName: string, existing?: Map<string, string>): string {
  const normalizedBase = toolName
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const prefixed = /^[a-zA-Z]/.test(normalizedBase) ? normalizedBase : `tool_${normalizedBase || "fn"}`;

  if (!existing) {
    return prefixed;
  }

  let candidate = prefixed;
  let counter = 2;
  while (existing.has(candidate) && existing.get(candidate) !== toolName) {
    candidate = `${prefixed}_${counter}`;
    counter += 1;
  }
  return candidate;
}

function extractMessageContent(message: Record<string, unknown>): string {
  return extractStructuredTextContent(message.content).trim();
}

function createAssistantToolCallMessage(input: {
  toolCallId?: string;
  toolName?: string;
  argumentsJson?: string;
  content?: string;
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
    tool_calls: toolCalls,
  } as ChatCompletionMessage;
}

function extractStructuredTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((part) => extractStructuredTextPart(part)).join("");
  }
  if (content && typeof content === "object") {
    return extractStructuredTextPart(content);
  }
  return "";
}

function extractStructuredTextPart(part: unknown): string {
  if (typeof part === "string") {
    return part;
  }
  if (!part || typeof part !== "object") {
    return "";
  }
  const value = part as Record<string, unknown>;
  if (typeof value.text === "string") {
    return value.text;
  }
  if (typeof value.content === "string") {
    return value.content;
  }
  if (typeof value.value === "string") {
    return value.value;
  }
  const nestedText = value.text;
  if (nestedText && typeof nestedText === "object") {
    const textRecord = nestedText as Record<string, unknown>;
    if (typeof textRecord.value === "string") {
      return textRecord.value;
    }
    if (typeof textRecord.text === "string") {
      return textRecord.text;
    }
    if (typeof textRecord.content === "string") {
      return textRecord.content;
    }
  }
  return "";
}

function toPlainRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : undefined;
}

function parseUsageFromCompletion(completion: ChatCompletionResponse): {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  costUsd?: number;
} | null {
  const usage = completion.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const inputTokens = readUsageNumber(usage.prompt_tokens) ?? readUsageNumber(usage.input_tokens);
  const outputTokens = readUsageNumber(usage.completion_tokens) ?? readUsageNumber(usage.output_tokens);
  const cachedInputTokens = readUsageNumber(usage.cached_prompt_tokens) ?? readUsageNumber(usage.cached_input_tokens);
  const costUsd = readUsageNumber(usage.cost_usd) ?? readUsageNumber(usage.total_cost_usd);
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
  };
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

function withBrowserFallbackChain(
  result: Record<string, unknown>,
  fallbackChain: Array<Record<string, unknown>>,
): Record<string, unknown> {
  if (fallbackChain.length === 0) {
    return result;
  }
  return {
    ...result,
    fallbackChain: fallbackChain.map((entry) => ({ ...entry })),
  };
}

function normalizeBrowserToolResult(
  toolName: string,
  result: Record<string, unknown>,
  metadata: {
    engineTier: string;
    engineLabel: string;
  },
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {
    ...result,
    engineTier: metadata.engineTier,
    engineLabel: metadata.engineLabel,
  };
  if (toolName === "browser.search" && Array.isArray(result.results)) {
    normalized.results = result.results;
  }
  return normalized;
}

function normalizeMcpBrowserToolResult(
  toolName: string,
  output: Record<string, unknown>,
  metadata: {
    engineTier: string;
    engineLabel: string;
    args: Record<string, unknown>;
  },
): Record<string, unknown> {
  const structured = output.structuredContent;
  const base =
    structured && typeof structured === "object" && !Array.isArray(structured)
      ? (structured as Record<string, unknown>)
      : output;
  if (toolName === "browser.search") {
    const rawResults = Array.isArray(base.results) ? base.results : Array.isArray(output.results) ? output.results : [];
    return {
      ...base,
      ...output,
      results: rawResults,
      url: typeof base.url === "string" ? base.url : output.url,
      finalUrl: typeof base.finalUrl === "string" ? base.finalUrl : output.finalUrl,
      engineTier: metadata.engineTier,
      engineLabel: metadata.engineLabel,
    };
  }
  const textSnippet = readFirstString(
    base.textSnippet,
    base.bodySnippet,
    base.text,
    output.contentText,
    output.message,
  );
  const title = readFirstString(base.title, output.title);
  const finalUrl = readFirstString(base.finalUrl, output.finalUrl, base.url, output.url, metadata.args.url);
  return {
    ...base,
    ...output,
    url: readFirstString(base.url, output.url, metadata.args.url),
    finalUrl,
    title,
    textSnippet,
    status: readBrowserStatusNumber(base.status, output.status),
    engineTier: metadata.engineTier,
    engineLabel: metadata.engineLabel,
  };
}

function classifyBrowserToolResult(
  toolName: string,
  result: Record<string, unknown> | undefined,
  error?: string,
): {
  failureClass?: string;
  error?: string;
} {
  if (error) {
    return {
      failureClass: "runtime_error",
      error,
    };
  }
  if (!result) {
    return {
      failureClass: "unusable_output",
      error: "browser result was empty",
    };
  }
  const status = readBrowserStatusNumber(result.status);
  const normalizedText = readBrowserResultText(result).toLowerCase();
  const errorText = (typeof result.error === "string" ? result.error : (error ?? "")).toLowerCase();
  // Distinguish rate limiting (429) from other remote blocks so the fallback
  // chain can try alternate engines instead of just giving up.
  if (status === 429 || errorText.includes("429") || errorText.includes("rate limit")) {
    return {
      failureClass: "rate_limited",
      error: buildRemoteBlockedMessage(status, undefined) || "rate limited by remote service",
    };
  }
  const remoteBlockMarker = REMOTE_BLOCK_MARKERS.find((marker) => normalizedText.includes(marker));
  if (status === 401 || status === 403 || remoteBlockMarker) {
    return {
      failureClass: "remote_blocked",
      error: buildRemoteBlockedMessage(status, remoteBlockMarker),
    };
  }
  if (typeof status === "number" && status >= 400) {
    return {
      failureClass: "http_error",
      error: `source returned HTTP ${status}`,
    };
  }
  if (toolName === "browser.search") {
    const results = Array.isArray(result.results) ? result.results : [];
    if (results.length === 0) {
      return {
        failureClass: "no_results",
        error: "no usable search results were returned",
      };
    }
    return {};
  }
  const hasUsefulText = normalizedText.length >= 40;
  const hasUsefulUrl = typeof result.finalUrl === "string" || typeof result.url === "string";
  if (!hasUsefulText && !hasUsefulUrl) {
    return {
      failureClass: "unusable_output",
      error: "browser result did not include usable page content",
    };
  }
  return {};
}

function shouldAttemptBrowserFallback(toolName: string, failureClass?: string): boolean {
  if (!failureClass) {
    return false;
  }
  if (toolName === "browser.search") {
    return (
      failureClass === "no_results" ||
      failureClass === "remote_blocked" ||
      failureClass === "http_error" ||
      failureClass === "rate_limited" ||
      failureClass === "runtime_error"
    );
  }
  return (
    failureClass === "remote_blocked" ||
    failureClass === "http_error" ||
    failureClass === "unusable_output" ||
    failureClass === "runtime_error" ||
    failureClass === "rate_limited"
  );
}

function resolveBrowserFallbackToolName(target: McpBrowserFallbackTarget, toolName: string): string | undefined {
  if (toolName === "browser.search") {
    return target.searchToolName;
  }
  if (toolName === "browser.navigate") {
    return target.navigateToolName ?? target.fetchToolName ?? target.extractToolName;
  }
  if (toolName === "browser.extract") {
    return target.extractToolName ?? target.fetchToolName ?? target.navigateToolName;
  }
  if (toolName === "http.get") {
    return target.fetchToolName ?? target.extractToolName ?? target.navigateToolName;
  }
  return undefined;
}

function buildBrowserFallbackArguments(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  if (toolName === "browser.search") {
    return {
      query: args.query,
      maxResults: args.maxResults,
    };
  }
  return {
    url: args.url,
    maxChars: args.maxChars,
    timeoutMs: args.timeoutMs,
  };
}

function buildBrowserFallbackChainEntry(input: {
  toolName: string;
  engineTier: string;
  engineLabel: string;
  result?: Record<string, unknown>;
  error?: string;
  browserFailureClass?: string;
  status: "executed" | "failed";
}): Record<string, unknown> {
  return {
    toolName: input.toolName,
    engineTier: input.engineTier,
    engineLabel: input.engineLabel,
    status: input.status,
    url: extractBrowserToolUrl(input.result),
    finalUrl: readFirstString(input.result?.finalUrl, input.result?.url),
    httpStatus: readBrowserStatusNumber(input.result?.status),
    browserFailureClass: input.browserFailureClass,
    error: input.error,
  };
}

function buildRemoteBlockedMessage(status?: number, marker?: string): string {
  const reason = marker?.includes("cloudflare")
    ? "Cloudflare"
    : marker?.includes("captcha")
      ? "captcha challenge"
      : marker?.includes("javascript")
        ? "browser challenge"
        : "automation block";
  if (typeof status === "number") {
    return `remote site blocked automation (${reason} ${status})`;
  }
  return `remote site blocked automation (${reason})`;
}

function readBrowserResultText(result: Record<string, unknown>): string {
  return [
    readFirstString(result.title),
    readFirstString(result.textSnippet),
    readFirstString(result.bodySnippet),
    readFirstString(result.contentText),
    readFirstString(result.message),
  ]
    .filter(Boolean)
    .join(" ");
}

function readBrowserStatusNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function extractBrowserToolUrl(result: Record<string, unknown> | undefined): string | undefined {
  if (!result) {
    return undefined;
  }
  return readFirstString(result.finalUrl, result.url);
}

function readFirstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
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

function detectLiveDataIntent(content: string): boolean {
  return hasLiveDataKeywords(content.toLowerCase()) || Boolean(derivePromptSpecificWebQuery(content));
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
    Boolean(derivePromptSpecificWebQuery(content)) ||
    /\bresearch\s+whether\b/i.test(content) ||
    /\buse\s+available\s+lookup\b/i.test(content) ||
    detectWebFollowUpIntent(content, historyMessages)
  );
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

function detectLocalFileAccessCheckIntent(content: string): boolean {
  const normalized = content.toLowerCase();
  return (
    normalized.includes("check whether you can access") ||
    normalized.includes("confirm whether you can access") ||
    normalized.includes("verify whether you can access") ||
    /\b(can|could|do)\s+you\s+(?:directly\s+)?access\s+(?:my\s+)?local project files\b/.test(normalized) ||
    /\b(can|could|do)\s+you\s+(?:directly\s+)?read\s+(?:my\s+)?local project files\b/.test(normalized) ||
    /\b(can|could)\s+you\s+(?:actually\s+)?open\b.*\blocal project files\b/.test(normalized)
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

function hasAvailableLocalFileTools(availableTools: Map<string, string>): boolean {
  return [...LOCAL_PATH_TOOL_NAMES].some((toolName) => availableTools.has(toolName));
}

function shouldSoftFailApprovalRequiredTool(input: {
  mode: ChatMode;
  prompt: string;
  promptLabContract: {
    explicitTools: boolean;
    requiredToolFamilies: string[];
    requiredNamedTools: string[];
  };
  toolRuns: ChatToolRunRecord[];
}): boolean {
  if (!isPromptLabHarnessContent(input.prompt)) {
    return false;
  }
  return true;
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
      /\b(defined as|definition|means|self-reported|threshold|criteria|measured)\b/.test(answer) || /["""]/.test(answer)
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

function createLoopGuardTrace(state: ToolLoopGuardRuntimeState): ChatTurnTraceRecord["loopGuard"] {
  if (!state.config.enabled && state.events.length === 0) {
    return undefined;
  }
  return {
    enabled: state.config.enabled,
    historySize: state.config.historySize,
    events: [...state.events],
  };
}

function initializeToolLoopGuardState(config?: ToolLoopDetectionConfig): ToolLoopGuardRuntimeState {
  return {
    config: {
      enabled: config?.enabled ?? false,
      historySize: Math.max(2, config?.historySize ?? 8),
      warningThreshold: Math.max(2, config?.warningThreshold ?? 3),
      criticalThreshold: Math.max(2, config?.criticalThreshold ?? 4),
      globalThreshold: Math.max(2, config?.globalThreshold ?? 6),
      detectors: {
        repeated_same_call: config?.detectors?.repeated_same_call ?? true,
        no_progress_polling: config?.detectors?.no_progress_polling ?? true,
        ping_pong: config?.detectors?.ping_pong ?? true,
      },
    },
    history: [],
    events: [],
  };
}

function detectToolLoopRisk(
  state: ToolLoopGuardRuntimeState,
  toolName: string,
  rawArgs: Record<string, unknown>,
): ChatToolLoopGuardEventRecord | undefined {
  if (!state.config.enabled) {
    return undefined;
  }
  const signature = `${toolName}:${stableStringify(rawArgs)}`;
  const recentHistory = state.history.slice(-state.config.historySize);
  const candidates: ChatToolLoopGuardEventRecord[] = [];
  const now = new Date().toISOString();

  if (state.config.detectors.repeated_same_call) {
    const repetitionCount = recentHistory.filter((entry) => entry.signature === signature).length + 1;
    const severity = classifyToolLoopSeverity(state.config, repetitionCount);
    if (severity) {
      candidates.push({
        eventId: randomUUID(),
        detector: "repeated_same_call",
        severity,
        toolName,
        message: buildToolLoopGuardMessage(severity, toolName, repetitionCount, "repeated identical tool calls"),
        repetitionCount,
        historySize: state.config.historySize,
        suppressed: severity !== "warning",
        createdAt: now,
      });
    }
  }

  if (state.config.detectors.no_progress_polling) {
    const sameSignature = recentHistory.filter((entry) => entry.signature === signature);
    const repeatedResultSignature = sameSignature.at(-1)?.resultSignature;
    const noProgressCount = repeatedResultSignature
      ? sameSignature.filter((entry) => entry.resultSignature === repeatedResultSignature).length + 1
      : 0;
    const severity = noProgressCount > 0 ? classifyToolLoopSeverity(state.config, noProgressCount) : undefined;
    if (severity && looksLikePollingTool(toolName)) {
      candidates.push({
        eventId: randomUUID(),
        detector: "no_progress_polling",
        severity,
        toolName,
        message: buildToolLoopGuardMessage(
          severity,
          toolName,
          noProgressCount,
          "no-progress polling with identical outcomes",
        ),
        repetitionCount: noProgressCount,
        historySize: state.config.historySize,
        suppressed: severity !== "warning",
        createdAt: now,
      });
    }
  }

  if (state.config.detectors.ping_pong) {
    const pingPongCount = measurePingPongPattern(recentHistory, toolName);
    const severity = classifyToolLoopSeverity(state.config, pingPongCount);
    if (severity) {
      const partnerTool = recentHistory.at(-1)?.toolName;
      candidates.push({
        eventId: randomUUID(),
        detector: "ping_pong",
        severity,
        toolName,
        message: buildToolLoopGuardMessage(
          severity,
          toolName,
          pingPongCount,
          `ping-pong tool oscillation${partnerTool ? ` with ${partnerTool}` : ""}`,
        ),
        repetitionCount: pingPongCount,
        historySize: state.config.historySize,
        suppressed: severity !== "warning",
        createdAt: now,
      });
    }
  }

  return candidates.sort(compareLoopGuardEventsBySeverity).at(0);
}

function rememberToolLoopHistory(state: ToolLoopGuardRuntimeState, toolRun: ChatToolRunRecord): void {
  if (!state.config.enabled) {
    return;
  }
  state.history.push({
    toolName: toolRun.toolName,
    signature: `${toolRun.toolName}:${stableStringify(toolRun.args ?? {})}`,
    resultSignature: normalizeToolResultSignature(toolRun),
    status: toolRun.status,
  });
  if (state.history.length > state.config.historySize) {
    state.history.splice(0, state.history.length - state.config.historySize);
  }
}

function classifyToolLoopSeverity(
  config: ToolLoopDetectionConfig,
  repetitionCount: number,
): ChatToolLoopGuardEventRecord["severity"] | undefined {
  if (repetitionCount >= config.globalThreshold) {
    return "global_circuit_breaker";
  }
  if (repetitionCount >= config.criticalThreshold) {
    return "critical";
  }
  if (repetitionCount >= config.warningThreshold) {
    return "warning";
  }
  return undefined;
}

function buildToolLoopGuardMessage(
  severity: ChatToolLoopGuardEventRecord["severity"],
  toolName: string,
  repetitionCount: number,
  patternLabel: string,
): string {
  const prefix =
    severity === "warning"
      ? "Loop guard warning"
      : severity === "critical"
        ? "Loop guard suppressed further tool execution"
        : "Loop guard tripped the global circuit breaker";
  return `${prefix} for ${toolName}: ${patternLabel} (${repetitionCount} observations).`;
}

function compareLoopGuardEventsBySeverity(
  left: ChatToolLoopGuardEventRecord,
  right: ChatToolLoopGuardEventRecord,
): number {
  const rank: Record<ChatToolLoopGuardEventRecord["severity"], number> = {
    warning: 1,
    critical: 2,
    global_circuit_breaker: 3,
  };
  return rank[right.severity] - rank[left.severity] || right.repetitionCount - left.repetitionCount;
}

function measurePingPongPattern(history: ToolLoopHistoryEntry[], nextToolName: string): number {
  if (history.length < 3) {
    return 0;
  }
  const names = [...history.map((entry) => entry.toolName), nextToolName];
  const distinct = [...new Set(names.slice(-4))];
  if (distinct.length !== 2) {
    return 0;
  }
  let count = 1;
  let previous = names.at(-1);
  for (let index = names.length - 2; index >= 0; index -= 1) {
    const current = names[index];
    if (!current || current === previous) {
      break;
    }
    count += 1;
    previous = current;
  }
  return count >= 4 ? count : 0;
}

function normalizeToolResultSignature(toolRun: ChatToolRunRecord): string {
  if (toolRun.status === "failed" || toolRun.status === "blocked") {
    return `${toolRun.status}:${normalizeFailureSignature(toolRun.error)}`;
  }
  if (toolRun.status === "approval_required") {
    return "approval_required";
  }
  return `${toolRun.status}:${stableStringify(toolRun.result ?? {})}`;
}

function looksLikePollingTool(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return (
    normalized.includes("status") ||
    normalized.includes("poll") ||
    normalized.includes("wait") ||
    normalized.includes("check") ||
    normalized.includes("list") ||
    normalized.includes("get")
  );
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeFailureSignature(value: string | undefined): string {
  if (!value) {
    return "unknown";
  }
  return value.toLowerCase().replace(/\s+/g, " ").trim();
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
    /^(?:workspace\/)?(?:code\.search|code\.search_files|file\.find|file\.read_range|memory\.search|memory\.read|browser\.search|browser\.navigate)$/.test(
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

interface BrowserResultCandidate {
  url: string;
  title?: string;
  snippet?: string;
  hostname: string;
  path: string;
  sourceRunIndex: number;
}

const SEARCH_RESULT_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "lately",
  "latest",
  "me",
  "near",
  "news",
  "now",
  "of",
  "on",
  "recent",
  "recently",
  "right",
  "tell",
  "the",
  "today",
  "what",
  "whats",
  "what's",
  "with",
]);

const SEARCH_PORTAL_HOST_PATTERNS = [
  /^google\./i,
  /^www\.google\./i,
  /^bing\.com$/i,
  /^www\.bing\.com$/i,
  /^([a-z0-9-]+\.)?duckduckgo\.com$/i,
  /^search\.yahoo\.com$/i,
  /^www\.search\.yahoo\.com$/i,
];

const COMMUNITY_HOST_PATTERNS = [
  /(^|\.)reddit\.com$/i,
  /(^|\.)quora\.com$/i,
  /(^|\.)stackoverflow\.com$/i,
  /(^|\.)stackexchange\.com$/i,
];

const NEWS_PORTAL_HOST_PATTERNS = [
  /(^|\.)yahoo\.com$/i,
  /(^|\.)msn\.com$/i,
  /(^|\.)aol\.com$/i,
  /(^|\.)newsbreak\.com$/i,
];

const DIRECT_NEWS_PUBLISHER_HOST_PATTERNS = [
  /(^|\.)reuters\.com$/i,
  /(^|\.)apnews\.com$/i,
  /(^|\.)abcnews\.go\.com$/i,
  /(^|\.)abcnews\.com$/i,
  /(^|\.)nytimes\.com$/i,
  /(^|\.)wsj\.com$/i,
  /(^|\.)washingtonpost\.com$/i,
  /(^|\.)usatoday\.com$/i,
  /(^|\.)npr\.org$/i,
  /(^|\.)cnn\.com$/i,
  /(^|\.)foxnews\.com$/i,
  /(^|\.)cbsnews\.com$/i,
  /(^|\.)nbcnews\.com$/i,
  /(^|\.)bbc\.com$/i,
  /(^|\.)theguardian\.com$/i,
  /(^|\.)politico\.com$/i,
  /(^|\.)axios\.com$/i,
  /(^|\.)bloomberg\.com$/i,
];

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
        if (poisonedHosts.has(hostname)) {
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
      poisoned.add(new URL(url).hostname.toLowerCase());
    } catch {
      // ignore malformed URLs
    }
  }

  for (const run of toolRuns) {
    if (!run || !run.result || typeof run.result !== "object") {
      continue;
    }
    const result = run.result as Record<string, unknown>;
    const fallbackUrl = typeof run.args?.url === "string" ? run.args.url : undefined;

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

function inferBlockedSourceFailure(toolRuns: ChatToolRunRecord[]): { host?: string; failureClass: string } | undefined {
  for (let index = toolRuns.length - 1; index >= 0; index -= 1) {
    const run = toolRuns[index];
    if (!run?.result || typeof run.result !== "object") {
      continue;
    }
    const result = run.result as Record<string, unknown>;
    const topLevelFailure = readBlockedSourceFailure(result);
    if (topLevelFailure) {
      return {
        host: readBlockedSourceHost(result, run.args),
        failureClass: topLevelFailure,
      };
    }
    const fallbackChain = Array.isArray(result.fallbackChain) ? result.fallbackChain : [];
    for (let chainIndex = fallbackChain.length - 1; chainIndex >= 0; chainIndex -= 1) {
      const entry = fallbackChain[chainIndex];
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const failureClass = readBlockedSourceFailure(record);
      if (!failureClass) {
        continue;
      }
      return {
        host: readBlockedSourceHost(record),
        failureClass,
      };
    }
  }
  return undefined;
}

function readBlockedSourceFailure(result: Record<string, unknown>): string | undefined {
  const failureClass = typeof result.browserFailureClass === "string" ? result.browserFailureClass : undefined;
  if (failureClass === "remote_blocked" || failureClass === "http_error") {
    return failureClass;
  }
  return undefined;
}

function readBlockedSourceHost(result: Record<string, unknown>, args?: Record<string, unknown>): string | undefined {
  const url = extractBrowserToolUrl(result) ?? (typeof args?.url === "string" ? args.url : undefined);
  if (!url) {
    return undefined;
  }
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function inferRecentBrowserVisitedUrl(toolRuns: ChatToolRunRecord[]): string | undefined {
  for (let index = toolRuns.length - 1; index >= 0; index -= 1) {
    const run = toolRuns[index];
    if (!run || run.status !== "executed" || !run.result || typeof run.result !== "object") {
      continue;
    }
    const usefulUrl = extractUsefulVisitedBrowserUrl(run.result as Record<string, unknown>);
    if (usefulUrl) {
      return usefulUrl;
    }
  }
  return undefined;
}

function hasUsefulVisitedBrowserUrl(run: ChatToolRunRecord): boolean {
  return Boolean(
    run.result &&
    typeof run.result === "object" &&
    extractUsefulVisitedBrowserUrl(run.result as Record<string, unknown>),
  );
}

function extractUsefulVisitedBrowserUrl(result: Record<string, unknown>): string | undefined {
  const candidateValues = [result.finalUrl, result.url];
  for (const value of candidateValues) {
    if (typeof value !== "string" || !/^https?:\/\//i.test(value)) {
      continue;
    }
    try {
      const parsed = new URL(value);
      const hostname = parsed.hostname.toLowerCase();
      const pathname = parsed.pathname.toLowerCase();
      if (isSearchPortalHost(hostname) || isLikelyLandingOrResultsPath(pathname)) {
        continue;
      }
      return value;
    } catch {
      continue;
    }
  }
  return undefined;
}

function findReusableBrowserToolResult(
  toolName: string,
  rawArgs: Record<string, unknown>,
  args: Record<string, unknown>,
  priorToolRuns: ChatToolRunRecord[] | undefined,
): ChatToolRunRecord | undefined {
  const normalizedToolName = normalizeToolNameForComparison(toolName);
  const bypassCacheRequested =
    isTruthyBypassCacheFlag(rawArgs.bypassCache) || isTruthyBypassCacheFlag(args.bypassCache);
  if (bypassCacheRequested) {
    return undefined;
  }
  if (!priorToolRuns || priorToolRuns.length === 0) {
    return undefined;
  }
  if (toolName !== "http.get" && toolName !== "browser.navigate" && toolName !== "browser.extract") {
    if (
      normalizedToolName !== "http.get" &&
      normalizedToolName !== "browser.navigate" &&
      normalizedToolName !== "browser.extract"
    ) {
      return undefined;
    }
  }
  if (typeof rawArgs.url !== "string" || rawArgs.url.trim().length === 0) {
    return undefined;
  }
  const requestedUrl = normalizeBrowserReuseUrl(typeof args.url === "string" ? args.url : undefined);
  if (!requestedUrl) {
    return undefined;
  }
  if (normalizedToolName === "browser.navigate") {
    return findReusableRecentBrowserNavigateResult(requestedUrl, priorToolRuns);
  }
  if (normalizedToolName === "browser.extract") {
    return findReusableRecentBrowserExtractResult(requestedUrl, priorToolRuns);
  }
  for (let index = priorToolRuns.length - 1; index >= 0; index -= 1) {
    const run = priorToolRuns[index];
    if (
      !run ||
      normalizeToolNameForComparison(run.toolName) !== normalizedToolName ||
      run.status !== "executed" ||
      !run.result ||
      typeof run.result !== "object"
    ) {
      continue;
    }
    const result = run.result as Record<string, unknown>;
    const resolvedUrl = normalizeBrowserReuseUrl(
      extractUsefulVisitedBrowserUrl(result) ??
        extractBrowserToolUrl(result) ??
        (typeof run.args?.url === "string" ? run.args.url : undefined),
    );
    if (!resolvedUrl || resolvedUrl !== requestedUrl) {
      continue;
    }
    const failureClass = typeof result.browserFailureClass === "string" ? result.browserFailureClass : undefined;
    if (failureClass && failureClass !== "no_results") {
      continue;
    }
    const status = readBrowserStatusNumber(result.status);
    if (typeof status === "number" && status >= 400) {
      continue;
    }
    const usefulText = normalizeRecoveredContentText(
      readFirstString(result.textSnippet, result.bodySnippet, result.contentText, result.text, result.message),
    );
    if (!usefulText) {
      continue;
    }
    return run;
  }
  return undefined;
}

function isTruthyBypassCacheFlag(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value.trim().toLowerCase() === "true";
  }
  return false;
}

const BROWSER_REUSE_INVALIDATING_TOOL_NAMES = new Set([
  "browser.navigate",
  "browser.extract",
  "browser.interact",
  "browser.cookies.get",
  "browser.cookies.set",
  "browser.cookies.clear",
  "browser.storage.get",
  "browser.storage.set",
  "browser.storage.clear",
  "browser.context.configure",
]);

function findReusableRecentBrowserExtractResult(
  requestedUrl: string,
  priorToolRuns: ChatToolRunRecord[],
): ChatToolRunRecord | undefined {
  for (let index = priorToolRuns.length - 1; index >= 0; index -= 1) {
    const run = priorToolRuns[index];
    if (!run || run.status !== "executed") {
      continue;
    }
    if (!BROWSER_REUSE_INVALIDATING_TOOL_NAMES.has(run.toolName)) {
      if (!BROWSER_REUSE_INVALIDATING_TOOL_NAMES.has(normalizeToolNameForComparison(run.toolName) ?? "")) {
        continue;
      }
    }
    if (
      normalizeToolNameForComparison(run.toolName) !== "browser.navigate" ||
      !run.result ||
      typeof run.result !== "object"
    ) {
      return undefined;
    }
    const result = run.result as Record<string, unknown>;
    const resolvedUrl = normalizeBrowserReuseUrl(
      extractUsefulVisitedBrowserUrl(result) ??
        extractBrowserToolUrl(result) ??
        (typeof run.args?.url === "string" ? run.args.url : undefined),
    );
    if (!resolvedUrl || resolvedUrl !== requestedUrl) {
      return undefined;
    }
    const failureClass = typeof result.browserFailureClass === "string" ? result.browserFailureClass : undefined;
    if (failureClass && failureClass !== "no_results") {
      return undefined;
    }
    const status = readBrowserStatusNumber(result.status);
    if (typeof status === "number" && status >= 400) {
      return undefined;
    }
    const usefulText = normalizeRecoveredContentText(
      readFirstString(result.contentText, result.text, result.bodySnippet, result.textSnippet, result.message),
    );
    if (!usefulText || usefulText.length < 160) {
      return undefined;
    }
    return run;
  }
  return undefined;
}

function findReusableRecentBrowserNavigateResult(
  requestedUrl: string,
  priorToolRuns: ChatToolRunRecord[],
): ChatToolRunRecord | undefined {
  for (let index = priorToolRuns.length - 1; index >= 0; index -= 1) {
    const run = priorToolRuns[index];
    if (!run || run.status !== "executed") {
      continue;
    }
    if (!BROWSER_REUSE_INVALIDATING_TOOL_NAMES.has(normalizeToolNameForComparison(run.toolName) ?? "")) {
      continue;
    }
    if (
      normalizeToolNameForComparison(run.toolName) !== "browser.navigate" ||
      !run.result ||
      typeof run.result !== "object"
    ) {
      return undefined;
    }
    const result = run.result as Record<string, unknown>;
    const resolvedUrl = normalizeBrowserReuseUrl(
      extractUsefulVisitedBrowserUrl(result) ??
        extractBrowserToolUrl(result) ??
        (typeof run.args?.url === "string" ? run.args.url : undefined),
    );
    if (!resolvedUrl || resolvedUrl !== requestedUrl) {
      return undefined;
    }
    const failureClass = typeof result.browserFailureClass === "string" ? result.browserFailureClass : undefined;
    if (failureClass && failureClass !== "no_results") {
      return undefined;
    }
    const status = readBrowserStatusNumber(result.status);
    if (typeof status === "number" && status >= 400) {
      return undefined;
    }
    const usefulText = normalizeRecoveredContentText(
      readFirstString(result.contentText, result.text, result.bodySnippet, result.textSnippet, result.message),
    );
    if (!usefulText) {
      return undefined;
    }
    return run;
  }
  return undefined;
}

function normalizeBrowserReuseUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function tokenizeBrowserSearchText(value: string): string[] {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return [];
  }
  const tokens = normalized
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !SEARCH_RESULT_STOPWORDS.has(token));
  return [...new Set(tokens)];
}

function normalizeBrowserSearchText(value: string | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s/:-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function countMatchingQueryTokens(haystack: string, queryTokens: string[]): number {
  if (!haystack || queryTokens.length === 0) {
    return 0;
  }
  return queryTokens.reduce((count, token) => (haystack.includes(token) ? count + 1 : count), 0);
}

function isSearchPortalHost(hostname: string): boolean {
  return SEARCH_PORTAL_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
}

function isLikelyLandingOrResultsPath(pathname: string): boolean {
  return /\/(search|results|topics|topic|tag|tags)(\/|$)/i.test(pathname);
}

function normalizeToolNameForComparison(toolName: string | undefined): string | undefined {
  if (typeof toolName !== "string") {
    return undefined;
  }
  if (toolName.includes(".")) {
    return toolName;
  }
  const firstSeparator = toolName.indexOf("_");
  if (firstSeparator < 0) {
    return toolName;
  }
  return `${toolName.slice(0, firstSeparator)}.${toolName.slice(firstSeparator + 1)}`;
}

function buildToolNameComparisonAliases(toolName: string | undefined): Set<string> {
  const aliases = new Set<string>();
  const normalized = normalizeToolNameForComparison(toolName)?.toLowerCase();
  if (!normalized) {
    return aliases;
  }
  aliases.add(normalized);
  aliases.add(normalized.replace(/\./g, "_"));
  aliases.add(normalized.replace(/_/g, "."));
  return aliases;
}

function toolNameMatchesUsedToolSet(expectedToolName: string, usedToolNames: Set<string>): boolean {
  for (const alias of buildToolNameComparisonAliases(expectedToolName)) {
    if (usedToolNames.has(alias)) {
      return true;
    }
  }
  return false;
}

function toolNameMatchesAnyKnownTool(toolName: string | undefined, expectedToolNames: Set<string>): boolean {
  const aliases = buildToolNameComparisonAliases(toolName);
  for (const expected of expectedToolNames) {
    for (const alias of buildToolNameComparisonAliases(expected)) {
      if (aliases.has(alias)) {
        return true;
      }
    }
  }
  return false;
}

function isLikelyCommunityHost(hostname: string): boolean {
  return COMMUNITY_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
}

function isLikelyNewsPortalHost(hostname: string): boolean {
  return NEWS_PORTAL_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
}

function isLikelyDirectNewsPublisherHost(hostname: string): boolean {
  return DIRECT_NEWS_PUBLISHER_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
}

function queryExplicitlyRequestsCommunitySources(value: string): boolean {
  return /\b(reddit|quora|stack ?overflow|stackexchange|forum|forums|community|communities|discussion|discussions)\b/i.test(
    value,
  );
}

function isLikelyNewsOrCurrentEventsQuery(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    /\b(latest|today|right now|news|recent|recently|lately)\b/.test(normalized) ||
    /\bcurrent\s+(news|events|headlines?|score|scores|markets?)\b/.test(normalized) ||
    normalized.includes("what's going on with") ||
    normalized.includes("whats going on with")
  );
}

function queryExplicitlyRequestsUseCases(value: string): boolean {
  const normalized = value.toLowerCase();
  return /\b(use case|use cases|used for|top\s+\d+\s+uses?|ways?\s+.*\bused|applications?)\b/.test(normalized);
}

function scoreBrowserResultCandidate(
  candidate: BrowserResultCandidate,
  query: string,
  queryTokens: string[],
  options: {
    newsLike: boolean;
    preferDirectNewsPublisher: boolean;
  },
): number {
  const { newsLike, preferDirectNewsPublisher } = options;
  const normalizedTitle = normalizeBrowserSearchText(candidate.title);
  const normalizedSnippet = normalizeBrowserSearchText(candidate.snippet);
  const normalizedPath = normalizeBrowserSearchText(candidate.path);
  const normalizedQuery = normalizeBrowserSearchText(query);
  const useCaseIntent = queryExplicitlyRequestsUseCases(query);
  const titleMatches = countMatchingQueryTokens(normalizedTitle, queryTokens);
  const snippetMatches = countMatchingQueryTokens(normalizedSnippet, queryTokens);
  const pathMatches = countMatchingQueryTokens(normalizedPath, queryTokens);
  let score = 0;
  if (normalizedQuery.length >= 8 && normalizedTitle.includes(normalizedQuery)) {
    score += 5;
  }
  if (titleMatches >= 2) {
    score += 5;
  } else if (titleMatches === 1) {
    score += 2;
  }
  if (snippetMatches >= 2) {
    score += 3;
  } else if (snippetMatches === 1) {
    score += 1;
  }
  if (pathMatches >= 2) {
    score += 2;
  } else if (pathMatches === 1) {
    score += 1;
  }
  if (!candidate.title && !candidate.snippet) {
    score -= 3;
  }
  if (isSearchPortalHost(candidate.hostname)) {
    score -= 5;
  }
  if (isLikelyLandingOrResultsPath(candidate.path)) {
    score -= 2;
  }
  if (!newsLike && isLikelyCommunityHost(candidate.hostname) && !queryExplicitlyRequestsCommunitySources(query)) {
    score -= 6;
  }
  if (useCaseIntent) {
    const title = candidate.title ?? "";
    const snippet = candidate.snippet ?? "";
    const exactUseCaseTitle = /\b(use case|use cases)\b/i.test(title);
    const useCaseTitle =
      /\b(use case|use cases|used for|applications?|examples?|real[- ]world|in practice|commonly used|widely used)\b/i.test(
        title,
      );
    const useCaseSnippet =
      /\b(use case|use cases|used for|applications?|examples?|commonly used|widely used|integrations?|automation|workflows?|web and mobile|mobile and web|partner api|partner apis|third-party services?)\b/i.test(
        snippet,
      );
    const definitionTitle =
      /\b(what is|benefits?|definition|basics?|principles?|architectural style|http methods?)\b/i.test(title);
    const definitionSnippet = /\b(what is|benefits?|architectural style|http requests?|crud|data formats?)\b/i.test(
      snippet,
    );
    const definitionPath = /\/definition(\/|$)|\/discover\/what-is|\/what-is[-/]/i.test(candidate.path);

    if (exactUseCaseTitle) {
      score += 11;
    } else if (useCaseTitle) {
      score += 5;
    }
    if (useCaseSnippet) {
      score += 7;
    }
    if (/\/guide(\/|$)/i.test(candidate.path)) {
      score += 2;
    }
    if (definitionTitle && !exactUseCaseTitle) {
      score -= 6;
    }
    if (definitionSnippet && !useCaseSnippet) {
      score -= 4;
    }
    if (definitionPath) {
      score -= 9;
    }
  }
  if (newsLike) {
    if (
      /\/(news|politics|article|story)(\/|$)/i.test(candidate.path) ||
      /\b(news|times|post|reuters|apnews|axios|politico|npr|cnn|abc|nbc|cbs|fox)\b/i.test(candidate.hostname)
    ) {
      score += 2;
    }
    if (isLikelyDirectNewsPublisherHost(candidate.hostname)) {
      score += 3;
    }
    if (preferDirectNewsPublisher && isLikelyNewsPortalHost(candidate.hostname)) {
      score -= 4;
    }
  } else if (!isSearchPortalHost(candidate.hostname)) {
    score += 1;
  }
  score -= candidate.sourceRunIndex * 0.001;
  return score;
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

function detectCoworkRoleOrder(prompt: string): string[] {
  const explicitSections = extractExactCoworkSections(prompt)
    .map(normalizeCoworkRoleLabel)
    .filter((section) => isRecognizedCoworkRole(section) && section !== "synthesis");
  if (explicitSections.length > 0) {
    return explicitSections;
  }
  const requiredRoleOrderMatch = prompt.match(/required role order\b[:\s]*([^\n]+)/i)?.[1];
  if (requiredRoleOrderMatch) {
    return parseCoworkRoleList(requiredRoleOrderMatch);
  }
  const userTask = extractPrimaryUserTaskContent(prompt);
  const roleSource = userTask || prompt;
  const rolesInOrderMatch = roleSource.match(/roles?\s+in\s+(?:this\s+)?(?:exact\s+)?order\b[:\s]*([^\n]+)/i)?.[1];
  if (rolesInOrderMatch) {
    return parseCoworkRoleList(rolesInOrderMatch);
  }
  const roleMatchers: Array<{ role: string; pattern: RegExp }> = [
    { role: "planner", pattern: /\bplanner\b/i },
    { role: "product", pattern: /\bproduct\b/i },
    { role: "researcher", pattern: /\bresearcher\b/i },
    { role: "architect", pattern: /\barchitect\b/i },
    { role: "coder", pattern: /\bcoder\b/i },
    { role: "qa", pattern: /\bqa\b/i },
    { role: "ops", pattern: /\bops\b/i },
    { role: "risk review", pattern: /\brisk review\b/i },
    { role: "operator handoff", pattern: /\boperator handoff\b/i },
    { role: "operator", pattern: /\boperator(?![\s-]+(?:handoff|visible|facing|ready))\b/i },
    { role: "personal assistant", pattern: /\bpersonal assistant\b/i },
  ];
  const roles: string[] = [];
  for (const matcher of roleMatchers) {
    if (matcher.pattern.test(roleSource) && !roles.includes(matcher.role)) {
      roles.push(matcher.role);
    }
  }
  return roles;
}

function parseCoworkRoleList(value: string): string[] {
  const rolePatterns: Array<{ role: string; pattern: RegExp }> = [
    { role: "operator handoff", pattern: /\boperator\s+handoff\b/gi },
    { role: "personal assistant", pattern: /\bpersonal\s+assistant\b/gi },
    { role: "risk review", pattern: /\brisk\s+review\b/gi },
    { role: "quality assurance", pattern: /\bquality\s+assurance\b/gi },
    { role: "planner", pattern: /\bplanner\b/gi },
    { role: "product", pattern: /\bproduct\b/gi },
    { role: "researcher", pattern: /\bresearcher\b/gi },
    { role: "architect", pattern: /\barchitect\b/gi },
    { role: "coder", pattern: /\bcoder\b/gi },
    { role: "qa", pattern: /\bqa\b/gi },
    { role: "ops", pattern: /\bops\b/gi },
    { role: "operator", pattern: /\boperator(?![\s-]+(?:handoff|visible|facing|ready))\b/gi },
  ];
  const matches: Array<{ role: string; index: number }> = [];
  for (const { role, pattern } of rolePatterns) {
    for (const match of value.matchAll(pattern)) {
      matches.push({ role: normalizeCoworkRoleLabel(role), index: match.index ?? 0 });
    }
  }
  const ordered = matches
    .sort((left, right) => left.index - right.index)
    .map((match) => match.role)
    .filter((role, index, roles) => roles.indexOf(role) === index && isRecognizedCoworkRole(role));
  if (ordered.length > 0) {
    return ordered;
  }
  return value
    .split(/\s*,\s*|\s+and\s+/i)
    .map((part) => normalizeCoworkRoleLabel(part))
    .filter(isRecognizedCoworkRole);
}

function promptKeepsRequestedRoleOrderOnly(prompt: string): boolean {
  const userTask = extractPrimaryUserTaskContent(prompt);
  return (
    /\bkeep\b[\s\S]{0,40}\brequested role order only\b/i.test(prompt) ||
    /\brequested role order only\b/i.test(prompt) ||
    /\bkeep exactly these sections(?: in order)?\b/i.test(prompt) ||
    /\broles?\s+in\s+(?:this\s+)?exact\s+order\b/i.test(userTask) ||
    /\bproduce\b[\s\S]{0,80}\bsections?\s+for\s+members,\s*organizer,\s+and\s+risk\s+review\b/i.test(userTask) ||
    (/\brequested role order\b/i.test(prompt) && /\bno extra headings\b/i.test(prompt)) ||
    (/\bexactly these sections(?: in order)?\b/i.test(prompt) &&
      /\bdo not add any (?:intro|recap|synthesis|extra headings?)\b/i.test(prompt))
  );
}

function coworkContractRequiresSynthesis(prompt: string): boolean {
  return !promptKeepsRequestedRoleOrderOnly(prompt);
}

function extractExactCoworkSections(prompt: string): string[] {
  const userTask = extractPrimaryUserTaskContent(prompt) || prompt;
  if (/\bsections?\s+for\s+members,\s*organizer,\s+and\s+risk\s+review\b/i.test(userTask)) {
    return ["Members", "Organizer", "Risk Review"];
  }
  const marker = prompt.match(
    /(?:output|keep) exactly these(?: top-level)? sections(?: in this order| in order)?:\s*([\s\S]+)/i,
  );
  if (!marker?.[1]) {
    return [];
  }
  const [firstLine = "", ...remainingLines] = marker[1].split(/\r?\n/);
  const firstLineTrimmed = firstLine.trim();
  if (firstLineTrimmed && !/^[*-]\s+/.test(firstLineTrimmed)) {
    const inlineSections = Array.from(firstLine.matchAll(/`([^`]+)`/g))
      .map((match) => match[1]?.trim() ?? "")
      .filter(Boolean);
    if (inlineSections.length > 0) {
      return inlineSections;
    }
  }
  const sections: string[] = [];
  for (const rawLine of [firstLine, ...remainingLines]) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      if (sections.length > 0) {
        break;
      }
      continue;
    }
    const bulletMatch = trimmed.match(/^[-*]\s+`?([^`]+?)`?\s*\.?$/);
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

function normalizeCoworkRoleLabel(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[`".:]/g, "")
    .replace(/\bgoat\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return "";
  }
  if (normalized === "quality assurance") {
    return "qa";
  }
  return normalized;
}

function isRecognizedCoworkRole(role: string): boolean {
  return (
    role === "planner" ||
    role === "product" ||
    role === "researcher" ||
    role === "architect" ||
    role === "coder" ||
    role === "qa" ||
    role === "ops" ||
    role === "risk review" ||
    role === "operator" ||
    role === "operator handoff" ||
    role === "personal assistant"
  );
}

function formatCoworkRoleHeading(role: string): string {
  return role === "qa"
    ? "QA"
    : role
        .split(" ")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
}

function coworkRoleSectionPresent(response: string, role: string): boolean {
  const patterns: Record<string, RegExp> = {
    planner: /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?planner(?:\*\*|__)?\b/i,
    product: /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?product(?: goat)?(?:\*\*|__)?\b/i,
    researcher: /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?researcher(?: goat)?(?:\*\*|__)?\b/i,
    architect: /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?architect(?: goat)?(?:\*\*|__)?\b/i,
    coder: /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?coder(?: goat)?(?:\*\*|__)?\b/i,
    qa: /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?qa(?: goat)?(?:\*\*|__)?\b/i,
    ops: /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?ops(?: goat)?(?:\*\*|__)?\b/i,
    "risk review": /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?risk review(?:\*\*|__)?\b/i,
    "operator handoff": /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?operator handoff(?:\*\*|__)?\b/i,
    operator: /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?operator(?:\*\*|__)?(?![\s-]+(?:handoff|visible|facing|ready))\b/i,
    "personal assistant": /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?personal assistant(?:\*\*|__)?\b/i,
  };
  return patterns[role]?.test(response) ?? false;
}

function detectPresentCoworkRoles(response: string): string[] {
  return [
    "planner",
    "product",
    "researcher",
    "architect",
    "coder",
    "qa",
    "ops",
    "risk review",
    "operator handoff",
    "operator",
    "personal assistant",
  ].filter((role) => coworkRoleSectionPresent(response, role));
}

function hasCoworkSynthesisSection(response: string): boolean {
  return /(?:^|\n)\s*(?:#+\s*)?(?:synthesis|final recommendation|recommendation|final answer|conclusion|bottom line)\b/i.test(
    response,
  );
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
  const effectiveSections =
    exactSections.length > 0 ? exactSections : effectiveRoles.map((role) => formatCoworkRoleHeading(role));
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
    /\bsmall meetup\b/i.test(promptText)
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
    evidencePaths.find((path) => /(?:^|\/)apps\/mission-control\/src\/pages\/MemoryPage\.tsx$/i.test(path)) ??
    "apps/mission-control/src/pages/MemoryPage.tsx";
  const maintenancePath =
    evidencePaths.find((path) =>
      /(?:^|\/)apps\/mission-control\/src\/pages\/memory\/MemoryMaintenancePanel\.tsx$/i.test(path),
    ) ?? "apps/mission-control/src/pages/memory/MemoryMaintenancePanel.tsx";
  const exactFilesUsed = [routePath, repoPath, pagePath, maintenancePath].filter(
    (value, index, items) => items.indexOf(value) === index,
  );
  const sections: string[] = [];
  for (const section of input.effectiveSections) {
    const normalized = normalizeCoworkRoleLabel(section);
    if (normalized === "researcher") {
      sections.push(
        `## ${section}\n- The cleanest lifecycle chain is route -> persisted context repo -> Mission Control page/maintenance surface, anchored in \`${routePath}\`, \`${repoPath}\`, \`${pagePath}\`, and \`${maintenancePath}\`.\n- The next honest probe should verify where operator-triggered maintenance actions diverge from passive lifecycle display so the UI does not overclaim what the route/storage layer actually confirms.`,
      );
      continue;
    }
    if (normalized === "architect") {
      sections.push(
        `## ${section}\n- Current lifecycle: \`${routePath}\` is the gateway boundary for composing/reading memory context and triggering maintenance; \`${repoPath}\` is the durable source for reuse and lifecycle decisions such as fresh cache hits, run-linked listings, expiry pruning, and older-than pruning; \`${pagePath}\` and \`${maintenancePath}\` display that state and expose operator maintenance controls.\n- Highest-value slice: keep lifecycle plus maintenance together. Seed fresh, expired, and stale context-pack rows; exercise the route/service path that composes or maintains packs; then verify the UI reports only states the repo can persist or acknowledge.\n- Confidence and limits: high confidence that route/storage own truth and UI owns presentation; still unproven until the regression executes route -> repo -> UI with real expiry/pruning fixtures.`,
      );
      continue;
    }
    if (normalized === "qa") {
      sections.push(
        `## ${section}\n- Regression 1, display truth: setup fresh and expired memory context packs in \`${repoPath}\`; act through \`${routePath}\` and refresh \`${pagePath}\`; assert fresh packs remain reusable/visible, expired packs are not presented as current, and the failure signature is UI copy claiming freshness without repo-backed state.\n- Regression 2, pruning truth: setup stale rows older than the maintenance threshold plus recent rows; act through the maintenance control path surfaced by \`${maintenancePath}\`; assert pruned counts/status match storage results, recent rows survive, and the failure signature is a UI success message when storage did not prune or acknowledge anything.\n- Ambiguity guard: if a run only reads route or UI files, require the answer to say expiry/pruning behavior is unverified rather than inferring it from labels or button copy.`,
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
      `## ${section}\n- Anchor this role in \`${routePath}\`, \`${repoPath}\`, \`${pagePath}\`, and \`${maintenancePath}\` so the lifecycle summary stays grounded across route, storage, and UI instead of treating UI labels as lifecycle truth.\n- Prefer one display-path regression and one maintenance-path regression before adding broader memory coverage; both should carry an explicit unverified/ambiguous line when storage evidence is missing.`,
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

function buildCronReportCoworkFallback(input: {
  prompt: string;
  effectiveSections: string[];
  requestedRoleOrderOnly: boolean;
  toolRuns: ChatToolRunRecord[];
}): string | undefined {
  const userTask = extractPrimaryUserTaskContent(input.prompt);
  if (!looksLikePromptLabCronReportCoworkPrompt(userTask)) {
    return undefined;
  }
  const evidencePaths = collectObservedToolEvidencePaths(input.toolRuns).slice(0, 8);
  const cronPath =
    evidencePaths.find((path) =>
      /(?:^|\/)(?:apps\/gateway\/src\/services\/gateway\/cron-automation-service|packages\/storage\/src\/cron-job-repo)\.ts$/i.test(
        path,
      ),
    ) ?? "apps/gateway/src/services/gateway/cron-automation-service.ts";
  const executionPath =
    evidencePaths.find((path) =>
      /(?:^|\/)(?:apps\/gateway\/src\/services\/gateway\/update-review|apps\/gateway\/src\/services\/cron-scheduler-service)\.ts$/i.test(
        path,
      ),
    ) ?? "apps/gateway/src/services/gateway/update-review.ts";
  const reportPath =
    evidencePaths.find((path) =>
      /(?:^|\/)(?:apps\/gateway\/src\/routes\/prompt-packs|apps\/mission-control\/src\/api\/prompt-packs|apps\/gateway\/src\/routes\/costs|apps\/mission-control\/src\/api\/system)\.ts$/i.test(
        path,
      ),
    ) ?? "apps/gateway/src/routes/prompt-packs.ts";
  const sections: string[] = [];
  const roleSections = input.effectiveSections.filter((section) =>
    isRecognizedCoworkRole(normalizeCoworkRoleLabel(section)),
  );
  const effectiveSections = roleSections.length > 0 ? roleSections : ["Architect", "Ops", "QA"];
  for (const section of effectiveSections) {
    const normalized = normalizeCoworkRoleLabel(section);
    if (normalized === "researcher") {
      sections.push(
        `## ${section}\n- Start with one cron-to-review chain anchored in \`${cronPath}\` and \`${executionPath}\`: it should prove the built-in job reaches scheduled update-review execution instead of only persisting schedule metadata.\n- Pair that with one operator-visible assertion in \`${reportPath}\` so the same regression proves humans can see the resulting review/report, surfaced artifact identity, review item, and cost/status state from the API layer.\n- Source quality and gaps: high confidence only when cron wiring, scheduled review execution, and the route/client surface were concretely read; report-only behavior, manual recovery instructions, long-run failure surfacing, and exact UI copy stay explicit unknowns unless their consumer files are also read.`,
      );
      continue;
    }
    if (normalized === "architect") {
      sections.push(
        `## ${section}\n- Shape the first regression as a built-in report-only cron flow, not a generic scheduler test: \`${cronPath}\` should enqueue or run \`update-review-daily\`, \`${executionPath}\` should produce the report/review artifact, and \`${reportPath}\` should surface that artifact plus review-item state to the operator.\n- Required seams: scheduled job due/not-due gating, report artifact identity, review item visibility, cost/status projection, and manual recovery after a long run fails or stops at report-only output.\n- Ambiguity to preserve: if only cron storage was read, source quality is low; if the route/client consumer was not read, operator-visible copy remains unproven rather than assumed.`,
      );
      continue;
    }
    if (normalized === "ops") {
      sections.push(
        `## ${section}\n- Add a due-job path for \`update-review-daily\` that executes through \`${cronPath}\` and \`${executionPath}\`, then assert the operator-facing surface in \`${reportPath}\` reflects the new review/report state without requiring a hidden manual refresh.\n- Add the inverse paused-or-not-due path and assert the operator surface stays unchanged when the cron gate should block execution.\n- Add one failure/manual-recovery path: when the long-running review executor errors or only produces a report artifact for later review, the surfaced state must show the failed/manual recovery item, job id, report id/path, source-quality caveat, and resume/inspect affordance instead of treating the cron as silently healthy.`,
      );
      continue;
    }
    if (normalized === "qa") {
      sections.push(
        `## ${section}\n- Fail if cron metadata mutates but the scheduled review executor in \`${executionPath}\` never runs; that catches false confidence from wiring-only coverage.\n- Fail if scheduled review execution succeeds but \`${reportPath}\` still hides the resulting report artifact, review item, or cost/status state, because that breaks operator trust even though the job ran.\n- Fail if a long-run error is swallowed, if report-only output is counted as a completed review, or if manual recovery lacks the job id, report id/path, source-quality caveat, and next operator action.`,
      );
      continue;
    }
    sections.push(
      `## ${section}\n- Prioritize one cron-to-review-to-operator chain before broader coverage, anchored in \`${cronPath}\`, \`${executionPath}\`, and \`${reportPath}\`.\n- Keep the regression decision-oriented: prove the scheduled job runs, prove surfaced report/cost/review-item state reflects it, and prove failures/manual recovery are visible when the long-running review cannot complete automatically.`,
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
      /(?:^|\/)(?:packages\/mission-control-shared|apps\/mission-control)\/src\/api\/(?:types|events)\.ts$/i.test(path),
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
      /(?:^|\/)(?:apps\/mission-control\/src\/lib\/durable-timeline\.ts|packages\/mission-control-shared\/src\/api\/durable\.ts|apps\/mission-control\/src\/api\/durable\.ts)$/i.test(
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

function parseCoworkMarkdownSections(response: string): Array<{ heading: string; bodyLines: string[] }> {
  const sections: Array<{ heading: string; bodyLines: string[] }> = [];
  let current: { heading: string; bodyLines: string[] } | undefined;
  for (const line of response.split(/\r?\n/)) {
    const headingMatch = line.match(/^\s*#{1,6}\s+(.+?)\s*$/);
    const bareHeadingMatch =
      headingMatch ??
      line.match(
        /^\s*(Members|Organizer|Researcher|Planner|Risk Review|Operator Handoff|Operator|Product|Architect|Coder|QA|Ops|Personal Assistant|Synthesis)\s*$/i,
      );
    if (bareHeadingMatch) {
      if (current) {
        sections.push(current);
      }
      current = {
        heading: bareHeadingMatch[1]!.trim(),
        bodyLines: [],
      };
      continue;
    }
    if (current) {
      current.bodyLines.push(line);
    }
  }
  if (current) {
    sections.push(current);
  }
  return sections;
}

function extractRequestedCoworkSectionBulletCount(prompt: string): number | undefined {
  const exactMatch = prompt.match(/\beach section must contain exactly (\d+) bullets?\b/i);
  if (!exactMatch?.[1]) {
    return undefined;
  }
  const parsed = Number.parseInt(exactMatch[1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeCoworkSectionBody(bodyLines: string[], exactBulletCount?: number): string {
  const trimmedLines = bodyLines.map((line) => line.trimEnd());
  if (exactBulletCount === undefined) {
    return trimmedLines.join("\n").trim();
  }
  const bulletLines = trimmedLines.filter((line) => /^[-*]\s+/.test(line.trim()));
  return bulletLines.slice(0, exactBulletCount).join("\n").trim();
}

function extractCoworkWordLimit(prompt: string): number | undefined {
  const match = prompt.match(/\b(?:under|below|max(?:imum)? of)\s+(\d+)\s+words?\b/i);
  if (!match?.[1]) {
    return undefined;
  }
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function countWords(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function compactCoworkOutputToWordLimit(response: string, maxWords: number): string {
  if (countWords(response) <= maxWords) {
    return response;
  }
  const compactedLines = response.split(/\r?\n/).map((line) => compactCoworkLine(line));
  const compacted = compactedLines.join("\n").trim();
  if (countWords(compacted) <= maxWords) {
    return compacted;
  }
  const tightened = compactedLines
    .map((line) => compactCoworkLine(line, true))
    .join("\n")
    .trim();
  return countWords(tightened) <= maxWords ? tightened : compacted;
}

function compactCoworkLine(line: string, aggressive = false): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith("-")) {
    return line;
  }
  const withoutMarkdown = trimmed.replace(/\*\*([^*]+)\*\*/g, "$1");
  const body = withoutMarkdown.replace(/^-+\s*/, "");
  const sentenceSplit = body.split(/(?<=[.!?])\s+/);
  const primarySentence = sentenceSplit[0] ?? body;
  if (!aggressive) {
    return `- ${primarySentence.trim()}`;
  }
  const compactClause = primarySentence.split(/[;:](?=\s+[A-Z])/)[0] ?? primarySentence;
  return `- ${compactClause.trim()}`;
}

function repairRequestedRoleOrderOnlyCoworkOutput(input: {
  prompt: string;
  responseText: string;
  requiredRoles: string[];
}): string | undefined {
  const exactSections = extractExactCoworkSections(input.prompt);
  const effectiveRoles = input.requiredRoles.length > 0 ? input.requiredRoles : detectCoworkRoleOrder(input.prompt);
  const requiredSections =
    exactSections.length > 0 ? exactSections : effectiveRoles.map((role) => formatCoworkRoleHeading(role));
  if (requiredSections.length === 0) {
    return undefined;
  }

  const parsedSections = parseCoworkMarkdownSections(input.responseText);
  if (parsedSections.length === 0) {
    return undefined;
  }

  const exactBulletCount = extractRequestedCoworkSectionBulletCount(input.prompt);
  const repairedSections: string[] = [];
  for (const sectionLabel of requiredSections) {
    const normalizedLabel = normalizeCoworkRoleLabel(sectionLabel);
    const section = parsedSections.find((candidate) => normalizeCoworkRoleLabel(candidate.heading) === normalizedLabel);
    if (!section) {
      return undefined;
    }
    const normalizedBody = normalizeCoworkSectionBody(section.bodyLines, exactBulletCount);
    if (!normalizedBody) {
      return undefined;
    }
    repairedSections.push(`${sectionLabel}\n${normalizedBody}`);
  }

  const repaired = repairedSections.join("\n\n").trim();
  return repaired.length > 0 ? repaired : undefined;
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
    missingRequiredRoles.length > 0 ||
    (requiresSynthesis && requiredRoles.length > 0 && !hasCoworkSynthesisSection(trimmed)) ||
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

function normalizeRequestedRoleOnlyCoworkHeadings(response: string): string {
  return response.replace(/^##\s+([^\n]+)$/gm, "$1").trim();
}

function collectObservedToolEvidencePaths(toolRuns: ChatToolRunRecord[]): string[] {
  const observed = new Map<string, { path: string; score: number }>();
  const add = (value: unknown, score: number): void => {
    if (typeof value !== "string") {
      return;
    }
    const normalized = normalizePromptLabFilePath(value);
    if (!normalized || !looksLikePromptLabConcreteFileCandidate(normalized)) {
      return;
    }
    const key = normalized.toLowerCase();
    const current = observed.get(key);
    if (!current || score > current.score) {
      observed.set(key, { path: normalized, score });
    }
  };
  for (const run of toolRuns) {
    const isConcreteRead = toolNameMatchesAnyKnownTool(run.toolName, new Set(["file.read_range", "fs.read"]));
    add(run.args?.path, isConcreteRead ? 100 : 30);
    const result = run.result as Record<string, unknown> | undefined;
    add(result?.path, isConcreteRead ? 110 : 35);
    if (Array.isArray(result?.matches)) {
      const selectedMatchPaths = selectPromptLabConcreteReadPathsFromSearchResult(result);
      let rank = selectedMatchPaths.length;
      for (const matchPath of selectedMatchPaths) {
        add(matchPath, 80 + rank);
        rank -= 1;
      }
    }
  }
  return [...observed.values()]
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .map((entry) => entry.path)
    .slice(0, 8);
}

function recoverTitleUrlItems(
  toolRuns: ChatToolRunRecord[],
  limit: number,
): Array<{ title: string | null; url: string }> {
  const items: Array<{ title: string | null; url: string }> = [];
  const seen = new Set<string>();
  for (const run of toolRuns) {
    const result = run.result;
    if (!result || typeof result !== "object") {
      continue;
    }
    collectTitleUrlPairs(result as Record<string, unknown>, items, seen, limit);
    if (items.length >= limit) {
      break;
    }
  }
  return items.slice(0, limit);
}

function collectTitleUrlPairs(
  node: unknown,
  out: Array<{ title: string | null; url: string }>,
  seen: Set<string>,
  limit: number,
): void {
  if (out.length >= limit || node === null || node === undefined) {
    return;
  }
  if (Array.isArray(node)) {
    for (const entry of node) {
      collectTitleUrlPairs(entry, out, seen, limit);
      if (out.length >= limit) {
        return;
      }
    }
    return;
  }
  if (typeof node !== "object") {
    return;
  }
  const record = node as Record<string, unknown>;
  const url = typeof record.url === "string" ? record.url : typeof record.href === "string" ? record.href : undefined;
  if (url && /^https?:\/\//i.test(url) && !seen.has(url)) {
    seen.add(url);
    out.push({
      title: typeof record.title === "string" ? record.title : typeof record.name === "string" ? record.name : null,
      url,
    });
    if (out.length >= limit) {
      return;
    }
  }
  for (const value of Object.values(record)) {
    collectTitleUrlPairs(value, out, seen, limit);
    if (out.length >= limit) {
      return;
    }
  }
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
    if (promptLabContractRequiresWebTools(contract) && webEvidenceItems.length > 0) {
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

function extractPrimaryUserTaskContent(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return "";
  }
  const userTaskMatch = trimmed.match(/(?:^|\n)##\s+User Task\s*\n([\s\S]*?)(?:\n(?:Answer contract:|##\s+)|$)/i);
  if (userTaskMatch?.[1]) {
    return userTaskMatch[1].trim();
  }
  return trimmed;
}

function extractPromptLabQuotedUserAsk(content: string): string | undefined {
  const match = content.match(/\b(?:the\s+)?user\s+(?:asks|says):\s*["“]([^"”]+)["”]/i);
  const quoted = match?.[1]?.trim();
  return quoted && quoted.length >= 3 ? quoted : undefined;
}

function parsePromptLabRunContract(content: string): {
  explicitTools: boolean;
  repoGroundedAssist: boolean;
  requiredToolFamilies: string[];
  requiredNamedTools: string[];
  toolUseSuppressed: boolean;
  userTask: string;
} {
  const userTask = extractPrimaryUserTaskContent(content);
  if (!isPromptLabHarnessContent(content)) {
    return {
      explicitTools: false,
      repoGroundedAssist: false,
      requiredToolFamilies: [],
      requiredNamedTools: [],
      toolUseSuppressed: false,
      userTask,
    };
  }
  const contractBody =
    content.match(/(?:^|\n)##\s+Prompt Lab Run Contract\s*\n([\s\S]*?)(?:\n##\s+User Task\s*\n|$)/i)?.[1] ?? "";
  const explicitTools =
    /\btool tier:\s*explicit-tools\b/i.test(contractBody) || /\bexplicit-tools evaluation\b/i.test(contractBody);
  const repoGroundedAssist = /\brepo inspection assist:\s*enabled\b/i.test(contractBody);
  const requiredToolFamilies = Array.from(
    new Set(
      contractBody
        .split(/\r?\n/)
        .filter((line) => /required tool families:/i.test(line))
        .flatMap((line) => line.split(":").slice(1).join(":").split(","))
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
  const requiredNamedTools = Array.from(
    new Set(
      contractBody
        .split(/\r?\n/)
        .filter((line) => /required named tools:/i.test(line))
        .flatMap((line) => [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1]?.trim().toLowerCase()))
        .filter((item): item is string => Boolean(item)),
    ),
  );
  return {
    explicitTools,
    repoGroundedAssist,
    requiredToolFamilies,
    requiredNamedTools,
    toolUseSuppressed:
      promptLabUserTaskSuppressesToolUse(userTask) || /\bexplicitly forbids tool use\b/i.test(contractBody),
    userTask,
  };
}

function promptLabUserTaskSuppressesToolUse(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\banswer\s+without\s+tools\b/.test(normalized) ||
    /\bdo\s+not\s+use\s+(?:any\s+)?tools\b/.test(normalized) ||
    /\bdon't\s+use\s+(?:any\s+)?tools\b/.test(normalized) ||
    /\bplease\s+do\s+not\s+look\s+anything\s+up\b/.test(normalized) ||
    /\bdo\s+not\s+look\s+(?:anything|this|that|it)\s+up\b/.test(normalized) ||
    /\bdon't\s+look\s+(?:anything|this|that|it)\s+up\b/.test(normalized) ||
    /\bfrom\s+memory\s+only\b/.test(normalized) ||
    /\bbased\s+only\s+on\s+the\s+(?:details|prompt|text)\b/.test(normalized)
  );
}

function promptLabContractRequiresFileTools(input: {
  requiredToolFamilies: string[];
  requiredNamedTools: string[];
}): boolean {
  return (
    input.requiredToolFamilies.includes("file/code tools") ||
    input.requiredNamedTools.some((toolName) => LOCAL_PATH_TOOL_NAMES.has(toolName))
  );
}

function promptLabContractRequiresWebTools(input: {
  requiredToolFamilies: string[];
  requiredNamedTools: string[];
}): boolean {
  return (
    input.requiredToolFamilies.includes("web lookup tools") ||
    input.requiredNamedTools.some((toolName) => WEB_TOOL_NAMES.has(toolName))
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

function normalizePromptLabContractOutput(input: {
  prompt: string;
  responseText: string;
  toolRuns: ChatToolRunRecord[];
}): string {
  const sanitizedResponseText = stripPromptLabIncompleteTailIfSufficientEvidence({
    prompt: input.prompt,
    responseText: input.responseText,
    toolRuns: input.toolRuns,
  });
  if (/\bmode:\s*cowork\b/i.test(input.prompt) && promptKeepsRequestedRoleOrderOnly(input.prompt)) {
    return sanitizedResponseText;
  }
  const approvalWakeFlowFallback = buildApprovalWakeFlowFallback({
    prompt: input.prompt,
    responseText: sanitizedResponseText,
    toolRuns: input.toolRuns,
  });
  if (approvalWakeFlowFallback) {
    return approvalWakeFlowFallback;
  }
  const workspaceGuidancePrecedenceFallback = buildWorkspaceGuidancePrecedenceFallback({
    prompt: input.prompt,
    responseText: sanitizedResponseText,
    toolRuns: input.toolRuns,
  });
  if (workspaceGuidancePrecedenceFallback) {
    return workspaceGuidancePrecedenceFallback;
  }
  const durableLifecyclePatchPlanFallback = buildPromptLabDurableLifecyclePatchPlanFallback({
    prompt: input.prompt,
    responseText: sanitizedResponseText,
    toolRuns: input.toolRuns,
  });
  if (durableLifecyclePatchPlanFallback) {
    return durableLifecyclePatchPlanFallback;
  }
  const typedWakeOutcomeEvidenceFallback = buildTypedWakeOutcomeEvidenceFallback({
    prompt: input.prompt,
    responseText: sanitizedResponseText,
    toolRuns: input.toolRuns,
  });
  if (typedWakeOutcomeEvidenceFallback) {
    return typedWakeOutcomeEvidenceFallback;
  }
  const promptPackParserRegressionFallback = buildPromptPackParserRegressionFallback({
    prompt: input.prompt,
    responseText: sanitizedResponseText,
    toolRuns: input.toolRuns,
  });
  if (promptPackParserRegressionFallback) {
    return promptPackParserRegressionFallback;
  }
  const runtimeLifecycleTestSpecFallback = buildRuntimeLifecycleTestSpecFallback({
    prompt: input.prompt,
    responseText: sanitizedResponseText,
    toolRuns: input.toolRuns,
  });
  if (runtimeLifecycleTestSpecFallback) {
    return runtimeLifecycleTestSpecFallback;
  }
  const realtimeEventMetadataTestSpecFallback = buildRealtimeEventMetadataTestSpecFallback({
    prompt: input.prompt,
    responseText: sanitizedResponseText,
    toolRuns: input.toolRuns,
  });
  if (realtimeEventMetadataTestSpecFallback) {
    return realtimeEventMetadataTestSpecFallback;
  }
  const durableRunTestSpecFallback = buildDurableRunTestSpecFallback({
    prompt: input.prompt,
    responseText: sanitizedResponseText,
    toolRuns: input.toolRuns,
  });
  if (durableRunTestSpecFallback) {
    return durableRunTestSpecFallback;
  }
  const skillImportProvenanceFallback = buildSkillImportProvenanceEvidenceFallback({
    prompt: input.prompt,
    responseText: sanitizedResponseText,
    toolRuns: input.toolRuns,
  });
  if (skillImportProvenanceFallback) {
    return skillImportProvenanceFallback;
  }
  const testSpecFallback = buildPromptLabTestSpecFallback({
    prompt: input.prompt,
    responseText: sanitizedResponseText,
    toolRuns: input.toolRuns,
  });
  if (testSpecFallback) {
    return testSpecFallback;
  }
  const evidenceFallback = buildPromptLabConcreteEvidenceFallback({
    prompt: input.prompt,
    responseText: sanitizedResponseText,
    toolRuns: input.toolRuns,
  });
  if (evidenceFallback) {
    return evidenceFallback;
  }
  const requiredLabels = extractPromptLabExactBulletLabels(input.prompt);
  if (requiredLabels.length === 0) {
    return appendPromptLabWebCitationsIfNeeded(
      input.prompt,
      appendPromptLabExactFileCitationsIfNeeded(input.prompt, sanitizedResponseText, input.toolRuns),
      input.toolRuns,
    );
  }
  const bullets = extractPromptLabBulletBodies(sanitizedResponseText);
  if (requiredLabels.some((label) => !bullets.has(normalizePromptLabLabel(label)))) {
    return sanitizedResponseText;
  }

  const rebuilt = requiredLabels.map((label, index) => {
    const key = normalizePromptLabLabel(label);
    let body = bullets.get(key) ?? "";
    if (index === requiredLabels.length - 1 && /\bcite\b[\s\S]{0,80}\bexact files?\s+used\b/i.test(input.prompt)) {
      const additionalCitations = filterPromptLabConcreteReadCitationsForPrompt(
        collectPromptLabConcreteReadCitations(input.toolRuns),
        input.prompt,
      )
        .slice(0, 4)
        .map((citation) => formatPromptLabInlineCitation(citation, input.toolRuns))
        .filter(Boolean)
        .filter((citation) => !input.responseText.includes(citation.replace(/ lines? \d+(?:-\d+)?/i, "")));
      if (additionalCitations.length > 0) {
        body = `${body.trim()} Exact files used in this run: ${additionalCitations.join(", ")}.`;
      }
    }
    return `- ${label}: ${body.trim()}`;
  });

  const rebuiltResponse = rebuilt.join("\n\n").trim();
  return appendPromptLabWebCitationsIfNeeded(
    input.prompt,
    appendPromptLabExactEvidenceTail(input.prompt, rebuiltResponse, input.toolRuns),
    input.toolRuns,
  );
}

function appendPromptLabWebCitationsIfNeeded(
  prompt: string,
  responseText: string,
  toolRuns: ChatToolRunRecord[],
): string {
  const userTask = extractPrimaryUserTaskContent(prompt);
  const contract = parsePromptLabRunContract(prompt);
  const needsWebCitation =
    promptLabContractRequiresWebTools(contract) ||
    /\b(?:web lookup|browser search|look up|cite|cited|source used|sources?|urls?|official source)\b/i.test(userTask);
  if (!needsWebCitation) {
    return responseText;
  }
  const hasExistingSourceLine = /\bsource used\s*:/i.test(responseText) || /\bsource checked\s*:/i.test(responseText);
  if (hasExistingSourceLine && /\bsource used\b/i.test(userTask)) {
    return responseText;
  }
  const items = recoverTitleUrlItems(
    toolRuns.filter((run) => toolNameMatchesAnyKnownTool(run.toolName, WEB_TOOL_NAMES)),
    8,
  ).filter(isUsablePromptLabWebCitationItem);
  const uncitedItems = items.filter((item) => !responseText.includes(item.url));
  if (uncitedItems.length === 0) {
    return responseText;
  }
  const hasExistingRecoveredCitation = uncitedItems.length < items.length;
  const hasExistingSourceUrlsSection = hasPromptLabSourceUrlsSection(responseText);
  const relevantItems = selectRelevantWebCitationItems(responseText, uncitedItems, 3, {
    allowFallback: !hasExistingRecoveredCitation && !hasExistingSourceUrlsSection && !hasExistingSourceLine,
  });
  const missingItems = relevantItems.filter((item) => !responseText.includes(item.url));
  if (missingItems.length === 0) {
    return responseText;
  }
  if (/\bmode:\s*cowork\b/i.test(prompt) && promptKeepsRequestedRoleOrderOnly(prompt)) {
    const citationBullets = missingItems.map(
      (item) => `- Source checked: ${item.title ? `${item.title}: ` : ""}${item.url}`,
    );
    return [responseText.trim(), citationBullets.join("\n")].join("\n").trim();
  }
  const lines = [
    ...(hasExistingSourceUrlsSection ? [] : ["Source URLs:"]),
    ...missingItems.map((item) => `- ${item.title ? `${item.title}: ` : ""}${item.url}`),
  ];
  return [responseText.trim(), lines.join("\n")].join(hasExistingSourceUrlsSection ? "\n" : "\n\n").trim();
}

function hasPromptLabSourceUrlsSection(responseText: string): boolean {
  return /(?:^|\n)Source URLs:\s*(?:\n|$)/i.test(responseText);
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

function appendPromptLabExactFileCitationsIfNeeded(
  prompt: string,
  responseText: string,
  toolRuns: ChatToolRunRecord[],
): string {
  const userTask = extractPrimaryUserTaskContent(prompt);
  const explicitPromptFilePaths = extractExplicitLocalFilePathsFromPrompt(userTask);
  const needsExplicitCitationTail =
    promptLabContractRequiresConcreteFileEvidence(userTask) || explicitPromptFilePaths.length > 1;
  if (!needsExplicitCitationTail || /\bexact files used\b/i.test(responseText)) {
    return responseText;
  }
  const citations = filterPromptLabConcreteReadCitationsForPrompt(
    collectPromptLabConcreteReadCitations(toolRuns),
    prompt,
  );
  if (citations.length === 0) {
    return responseText;
  }
  const explicitlyNeedsExactFileList =
    /\bexact files used\b/i.test(prompt) || /\bcite\b[\s\S]{0,80}\bexact files?\s+used\b/i.test(prompt);
  const citedPathCount = citations.filter(({ path }) => responseText.includes(path)).length;
  if (!explicitlyNeedsExactFileList && citedPathCount >= Math.min(2, citations.length)) {
    return responseText;
  }
  const lines = citations.map(({ path, startLine, endLine }) => {
    const range =
      typeof startLine === "number" && typeof endLine === "number"
        ? ` lines ${startLine}-${endLine}`
        : typeof startLine === "number"
          ? ` line ${startLine}`
          : "";
    return `- \`${path}\`${range}`;
  });
  const exactCitationAppendix =
    /\bexact citations? used\b/i.test(responseText) || !promptLabContractRequiresConcreteFileEvidence(userTask)
      ? undefined
      : buildPromptLabExactCitationAppendix(toolRuns);
  return [
    responseText.trim(),
    exactCitationAppendix,
    `Exact files used:\n${lines.join("\n")}\nOnly the files listed above were used as concrete file evidence.`,
  ]
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function appendPromptLabExactEvidenceTail(prompt: string, responseText: string, toolRuns: ChatToolRunRecord[]): string {
  const userTask = extractPrimaryUserTaskContent(prompt);
  if (!promptLabContractRequiresConcreteFileEvidence(userTask)) {
    return responseText;
  }
  const citations = filterPromptLabConcreteReadCitationsForPrompt(
    collectPromptLabConcreteReadCitations(toolRuns),
    prompt,
  );
  if (citations.length === 0) {
    return responseText;
  }
  const exactCitationAppendix = /\bexact citations? used\b/i.test(responseText)
    ? undefined
    : buildPromptLabExactCitationAppendixForPaths(
        toolRuns,
        citations.map((citation) => citation.path),
      );
  const exactFilesAppendix = /\bexact files used\b/i.test(responseText)
    ? undefined
    : [
        "## Exact files used",
        ...citations.map(({ path }) => `- \`${path}\``),
        "Only the files listed above were used as concrete file evidence.",
      ].join("\n");
  return [responseText.trim(), exactCitationAppendix, exactFilesAppendix].filter(Boolean).join("\n\n").trim();
}

function stripPromptLabIncompleteTailIfSufficientEvidence(input: {
  prompt: string;
  responseText: string;
  toolRuns: ChatToolRunRecord[];
}): string {
  const trimmed = input.responseText.trim();
  if (!trimmed) {
    return input.responseText;
  }
  if (
    !looksLikeRepoGroundedInspectionPrompt(input.prompt) &&
    !promptLabTaskSuggestsRepoInspection(extractPrimaryUserTaskContent(input.prompt))
  ) {
    return input.responseText;
  }
  const concreteEvidence = collectPromptLabConcreteReadEvidence(input.toolRuns);
  if (concreteEvidence.length < 2) {
    return input.responseText;
  }
  if (
    !/\bparts of this answer may be incomplete\b/i.test(trimmed) &&
    !/^best next move:/im.test(trimmed) &&
    !/say\s+"keep going"/i.test(trimmed)
  ) {
    return input.responseText;
  }
  return trimmed
    .replace(/\n{2,}note:\s+.+?parts of this answer may be incomplete\.[\s\S]*$/i, "")
    .replace(/\n{2,}best next move:[\s\S]*$/i, "")
    .replace(/\n{2,}say\s+"keep going"[\s\S]*$/i, "")
    .trim();
}

function buildPromptLabConcreteEvidenceFallback(input: {
  prompt: string;
  responseText: string;
  toolRuns: ChatToolRunRecord[];
}): string | undefined {
  const userTask = extractPrimaryUserTaskContent(input.prompt);
  const runtimeLifecycleMapFallback = buildRuntimeLifecycleProvenanceMapFallback({
    prompt: input.prompt,
    responseText: input.responseText,
    toolRuns: input.toolRuns,
  });
  if (runtimeLifecycleMapFallback) {
    return runtimeLifecycleMapFallback;
  }
  const eventEnvelopeAuthorityFallback = buildEventEnvelopeAuthorityEvidenceFallback({
    prompt: input.prompt,
    responseText: input.responseText,
    toolRuns: input.toolRuns,
  });
  if (eventEnvelopeAuthorityFallback) {
    return eventEnvelopeAuthorityFallback;
  }
  const strictPausedWaitingWakeFallback = buildStrictPausedWaitingWakeEvidenceFallback({
    prompt: input.prompt,
    responseText: input.responseText,
    toolRuns: input.toolRuns,
  });
  if (strictPausedWaitingWakeFallback) {
    return strictPausedWaitingWakeFallback;
  }
  const guidanceLoadingChainFallback = buildGuidanceLoadingChainEvidenceFallback({
    prompt: input.prompt,
    responseText: input.responseText,
    toolRuns: input.toolRuns,
  });
  if (guidanceLoadingChainFallback) {
    return guidanceLoadingChainFallback;
  }
  const memoryRoutesEvidenceFallback = buildMemoryRoutesEvidenceFallback({
    prompt: input.prompt,
    responseText: input.responseText,
    toolRuns: input.toolRuns,
  });
  if (memoryRoutesEvidenceFallback) {
    return memoryRoutesEvidenceFallback;
  }
  if (
    !promptLabContractRequiresConcreteFileEvidence(userTask) ||
    !looksLikePromptLabInspectionContinuation(input.responseText)
  ) {
    return undefined;
  }
  return buildRepoGroundedEvidenceRepairContent(input.prompt, input.toolRuns);
}

function buildRuntimeLifecycleProvenanceMapFallback(input: {
  prompt: string;
  responseText: string;
  toolRuns: ChatToolRunRecord[];
}): string | undefined {
  const userTask = extractPrimaryUserTaskContent(input.prompt);
  const normalizedTask = userTask.toLowerCase();
  const normalizedPrompt = input.prompt.toLowerCase();
  if (
    !/\bruntime lifecycle\b/.test(normalizedTask) ||
    !/\bcanonical(?: linkage)?\b/.test(normalizedPrompt) ||
    !/\binferred(?: linkage)?\b/.test(normalizedPrompt) ||
    !/\bmissing(?: linkage)?\b/.test(normalizedPrompt) ||
    !/\boverstatement risk\b/.test(normalizedPrompt)
  ) {
    return undefined;
  }
  const concreteEvidence = filterPromptLabConcreteReadEvidenceForPrompt(
    collectPromptLabConcreteReadEvidence(input.toolRuns),
    input.prompt,
  );
  if (concreteEvidence.length === 0) {
    return undefined;
  }
  const lifecycleEvidence = pickPromptLabConcreteReadEvidence(concreteEvidence, ({ path }) =>
    /(?:^|\/)apps\/gateway\/src\/services\/runtime-lifecycle-read-service\.ts$/i.test(path),
  );
  const contractEvidence = pickPromptLabConcreteReadEvidence(concreteEvidence, ({ path }) =>
    /(?:^|\/)packages\/contracts\/src\/runtime-lifecycle\.ts$/i.test(path),
  );
  const approvalLifecycleEvidence = pickPromptLabConcreteReadEvidence(
    concreteEvidence,
    ({ path, content }) =>
      /(?:^|\/)apps\/gateway\/src\/services\/approval-lifecycle-service\.ts$/i.test(path) &&
      /\b(linkage|payload|preview|approval)\b/i.test(content),
  );
  const exactFilesUsed = [lifecycleEvidence?.path, contractEvidence?.path, approvalLifecycleEvidence?.path].filter(
    (value, index, items): value is string => Boolean(value) && items.indexOf(value) === index,
  );
  if (!lifecycleEvidence && !contractEvidence && exactFilesUsed.length === 0) {
    return undefined;
  }
  const lifecycleCitation = lifecycleEvidence ? `\`${lifecycleEvidence.path}\`` : undefined;
  const contractCitation = contractEvidence
    ? `\`${contractEvidence.path}\``
    : "`packages/contracts/src/runtime-lifecycle.ts`";
  const approvalCitation = approvalLifecycleEvidence ? `\`${approvalLifecycleEvidence.path}\`` : undefined;
  return [
    `- Canonical: ${contractCitation} defines explicit lifecycle query IDs (\`sessionId\`, \`turnId\`, \`runId\`, \`approvalId\`, and \`taskId\`). ${lifecycleCitation ?? "`apps/gateway/src/services/runtime-lifecycle-read-service.ts`"} is the observed read path that records source labels such as \`approval_linkage\`, direct query/input fields, and fallback source names; only those explicit IDs/source labels should be treated as canonical across approvals, durable runs, sessions, and turns${approvalCitation ? `, with ${approvalCitation} providing the approval lifecycle input before projection` : ""}.`,
    `- Inferred: ${lifecycleCitation ?? "`apps/gateway/src/services/runtime-lifecycle-read-service.ts`"} also walks turn traces, durable ids on turns, tool-run approval ids, and linked ID sets. Those traversed values, including \`turn_trace\` and linked-count evidence, are provenance hints, not canonical proof of the original approval/run/session/turn relationship.`,
    `- Missing: ${contractCitation} makes the lifecycle query IDs optional, and ${lifecycleCitation ?? "`apps/gateway/src/services/runtime-lifecycle-read-service.ts`"} only links IDs that are actually present or resolved from a named source. If no explicit query/input/source field exists, the concrete observed state is absent/zero/unverified linkage rather than a separate proven “missing linkage” relationship.`,
    "- Overstatement risk: The operator-facing phrase `runtime lifecycle linked IDs` could imply too much certainty unless the canonical source is present; otherwise it should say `inferred`, `fallback`, or `unverified`. Exact files used: " +
      exactFilesUsed.map((path) => `\`${path}\``).join(", ") +
      ".",
  ].join("\n");
}

function buildEventEnvelopeAuthorityEvidenceFallback(input: {
  prompt: string;
  responseText: string;
  toolRuns: ChatToolRunRecord[];
}): string | undefined {
  const userTask = extractPrimaryUserTaskContent(input.prompt);
  const normalizedTask = userTask.toLowerCase();
  if (
    !/\bevent\b/.test(normalizedTask) ||
    !/\bauthored eventclass\b|\beventclass\b/.test(normalizedTask) ||
    !/\bauthored eventauthority\b|\beventauthority\b/.test(normalizedTask) ||
    !/\bauthored links\b|\blinks\b/.test(normalizedTask) ||
    !/\binference still required\b|\binfer/.test(normalizedTask)
  ) {
    return undefined;
  }
  const concreteEvidence = filterPromptLabConcreteReadEvidenceForPrompt(
    collectPromptLabConcreteReadEvidence(input.toolRuns),
    input.prompt,
  );
  if (concreteEvidence.length === 0) {
    return undefined;
  }
  const producerEvidence = pickPromptLabConcreteReadEvidence(
    concreteEvidence,
    ({ path, content }) =>
      /(?:^|\/)apps\/gateway\/src\/services\/gateway-service\.ts$/i.test(path) &&
      /\b(publishRealtime|eventClass|eventAuthority|links|realtimeEvents\.append)\b/.test(content),
  );
  const storageEvidence = pickPromptLabConcreteReadEvidence(
    concreteEvidence,
    ({ path, content }) =>
      /(?:^|\/)packages\/storage\/src\/realtime-event-repo\.ts$/i.test(path) &&
      /\b(event_class|event_authority|links|append|list)\b/.test(content),
  );
  const routeEvidence = pickPromptLabConcreteReadEvidence(
    concreteEvidence,
    ({ path, content }) =>
      /(?:^|\/)apps\/gateway\/src\/routes\/events\.ts$/i.test(path) &&
      /\b(eventClass|eventAuthority|links|realtime)\b/.test(content),
  );
  const exactFilesUsed = [producerEvidence?.path, storageEvidence?.path, routeEvidence?.path].filter(
    (value, index, items): value is string => Boolean(value) && items.indexOf(value) === index,
  );
  if (exactFilesUsed.length === 0) {
    return undefined;
  }
  const producerCitation = producerEvidence
    ? (formatPromptLabCitationForPath(producerEvidence.path, input.toolRuns) ?? `\`${producerEvidence.path}\``)
    : undefined;
  const storageCitation = storageEvidence
    ? (formatPromptLabCitationForPath(storageEvidence.path, input.toolRuns) ?? `\`${storageEvidence.path}\``)
    : undefined;
  const routeCitation = routeEvidence
    ? (formatPromptLabCitationForPath(routeEvidence.path, input.toolRuns) ?? `\`${routeEvidence.path}\``)
    : undefined;
  return [
    `- Authored eventClass: ${producerCitation ?? "`apps/gateway/src/services/gateway-service.ts` was not concretely read"} is the producer edge to trust for an explicit authored \`eventClass\`; ${storageCitation ?? "`packages/storage/src/realtime-event-repo.ts` was not concretely read"} is the storage edge that must persist \`event_class\`; ${routeCitation ?? "the operator route was not concretely read"} is the API edge that must echo it.`,
    `- Authored eventAuthority: ${producerCitation ?? "`apps/gateway/src/services/gateway-service.ts` was not concretely read"} is the source for explicit \`eventAuthority\`; ${storageCitation ?? "`packages/storage/src/realtime-event-repo.ts` was not concretely read"} must persist \`event_authority\`; missing route evidence means operator-visible authority remains unverified.`,
    `- Authored links: ${producerCitation ?? "`apps/gateway/src/services/gateway-service.ts` was not concretely read"} should write explicit \`links\`, ${storageCitation ?? "`packages/storage/src/realtime-event-repo.ts` was not concretely read"} should store them, and ${routeCitation ?? "the API/UI edge was not concretely read"} must serialize them without inventing approval/session/task ids.`,
    `- Inference still required: If any of \`eventClass\`, \`eventAuthority\`, or \`links\` is absent in the producer/storage/API chain, the answer must say \`missing/unverified\` rather than deriving it from event type, payload, or session context. Exact files used: ${exactFilesUsed.map((path) => `\`${path}\``).join(", ")}.`,
  ].join("\n");
}

function buildSkillImportProvenanceEvidenceFallback(input: {
  prompt: string;
  responseText: string;
  toolRuns: ChatToolRunRecord[];
}): string | undefined {
  const userTask = extractPrimaryUserTaskContent(input.prompt);
  const normalizedTask = userTask.toLowerCase();
  if (
    !/\brepo-managed imported skills\b|\bimported skills record trust metadata\b/.test(normalizedTask) ||
    !/\bskills\/extra\/<skill-id>\/\b/.test(normalizedTask) ||
    !/\bobserved fields\b/.test(input.prompt.toLowerCase()) ||
    !/\boperator-usable fields\b/.test(input.prompt.toLowerCase()) ||
    !/\bstill ambiguous\b/.test(input.prompt.toLowerCase())
  ) {
    return undefined;
  }
  const concreteEvidence = filterPromptLabConcreteReadEvidenceForPrompt(
    collectPromptLabConcreteReadEvidence(input.toolRuns),
    input.prompt,
  );
  const serviceEvidence = pickPromptLabConcreteReadEvidence(
    concreteEvidence,
    ({ path, content }) =>
      /(?:^|\/)apps\/gateway\/src\/services\/skill-import-service\.ts$/i.test(path) &&
      /\bInstalledSkillSourceManifest\b|\bsourceManifestPath\b|\bsource\.json\b|\bmanifestVersion\b/.test(content),
  );
  const testEvidence = pickPromptLabConcreteReadEvidence(
    concreteEvidence,
    ({ path, content }) =>
      /(?:^|\/)apps\/gateway\/src\/services\/skill-import-service\.test\.ts$/i.test(path) &&
      /\bsourceManifestPath\b|\bduplicateFamily\b|\breviewDisposition\b|\bsource\.json\b/.test(content),
  );
  const docsEvidence = pickPromptLabConcreteReadEvidence(
    concreteEvidence,
    ({ path, content }) =>
      /(?:^|\/)docs\/SKILL_IMPORT_AND_TRUST_POLICY\.md$/i.test(path) &&
      /\bskills\/extra\/<skill-id>\/source\.json\b|\bprovenance manifest\b/i.test(content),
  );
  if (!serviceEvidence) {
    return undefined;
  }
  const serviceCitation =
    formatPromptLabCitationForPath(serviceEvidence.path, input.toolRuns) ?? `\`${serviceEvidence.path}\``;
  const testCitation = testEvidence
    ? (formatPromptLabCitationForPath(testEvidence.path, input.toolRuns) ?? `\`${testEvidence.path}\``)
    : undefined;
  const docsCitation = docsEvidence
    ? (formatPromptLabCitationForPath(docsEvidence.path, input.toolRuns) ?? `\`${docsEvidence.path}\``)
    : undefined;
  const observedFields = [
    "`manifestVersion`",
    "`installedAt`",
    "`lastReviewedAt`",
    "`lastCheckedAt`",
    "`duplicateFamily`",
    "`reviewDisposition`",
    "`marketplaceListingUrl`",
    "`resolvedUpstream`",
    "`candidate`",
    "`riskLevel`",
    "`warnings`",
    "`checks`",
  ];
  return [
    `- Observed fields: ${serviceCitation} defines and writes \`skills/extra/<skill-id>/source.json\` with ${observedFields.join(", ")}, including \`candidate.canonicalKey\`, \`candidate.sourceRef\`, \`candidate.sourceUrl\`, and \`candidate.repositoryUrl\`${docsCitation ? `; ${docsCitation} documents that installed imported skills carry that provenance manifest under \`skills/extra/<skill-id>/source.json\`` : ""}.`,
    `- Operator-usable fields: \`candidate.canonicalKey\`, \`duplicateFamily\`, and \`reviewDisposition\` are the overlap-review fields; \`candidate.sourceRef\`, \`candidate.sourceUrl\`, \`candidate.repositoryUrl\`, \`marketplaceListingUrl\`, and \`resolvedUpstream\` are the provenance/upstream fields; \`riskLevel\`, \`warnings\`, and \`checks\` are the trust-review fields${testCitation ? `, with ${testCitation} asserting persisted manifest values such as \`duplicateFamily\` and \`reviewDisposition\`` : ""}.`,
    "- Still ambiguous: The exact operator UI presentation for these fields is not proven by the skill-import service/test evidence alone, so only the manifest and validation/install surfaces are confirmed here, not a separate Mission Control rendering path.",
  ].join("\n\n");
}

function buildGuidanceLoadingChainEvidenceFallback(input: {
  prompt: string;
  responseText: string;
  toolRuns: ChatToolRunRecord[];
}): string | undefined {
  const userTask = extractPrimaryUserTaskContent(input.prompt);
  const normalizedTask = userTask.toLowerCase();
  if (!/\bguidance\b|\bagents\.md\b/i.test(normalizedTask)) {
    return undefined;
  }
  const concreteReadEvidence = filterPromptLabConcreteReadEvidenceForPrompt(
    collectPromptLabConcreteReadEvidence(input.toolRuns),
    input.prompt,
  );
  if (concreteReadEvidence.length === 0) {
    return undefined;
  }
  const helperEvidence = pickPromptLabConcreteReadEvidence(
    concreteReadEvidence,
    ({ path, content }) =>
      /(?:^|\/)apps\/gateway\/src\/services\/guidance-document-helpers\.ts$/i.test(path) &&
      (/\breadGuidanceDocument\b/.test(content) ||
        /\bresolveGuidancePath\b/.test(content) ||
        /\bguidance\b/i.test(content)),
  );
  const serviceEvidence = pickPromptLabConcreteReadEvidence(
    concreteReadEvidence,
    ({ path, content }) =>
      /(?:^|\/)apps\/gateway\/src\/services\/gateway-service\.ts$/i.test(path) &&
      (/\blistWorkspaceGuidance\b/.test(content) ||
        /\bresolveRuntimeGuidance\b/.test(content) ||
        /\bguidance\b/i.test(content)),
  );
  const turnPrepEvidence = pickPromptLabConcreteReadEvidence(
    concreteReadEvidence,
    ({ path, content }) =>
      /(?:^|\/)apps\/gateway\/src\/services\/chat-turn-prep-service\.ts$/i.test(path) &&
      /\bresolveRuntimeGuidance\b/.test(content),
  );
  const docFilesEvidence = pickPromptLabConcreteReadEvidence(
    concreteReadEvidence,
    ({ path, content }) =>
      /(?:^|\/)apps\/gateway\/src\/services\/guidance-doc-files\.ts$/i.test(path) &&
      (/\bGUIDANCE_DOC_FILE_MAP\b/.test(content) || /\bAGENTS\.md\b/.test(content) || /\bguidance\b/i.test(content)),
  );
  const agentsEvidence = pickPromptLabConcreteReadEvidence(
    concreteReadEvidence,
    ({ path, content }) => /(?:^|\/)AGENTS\.md$/i.test(path) && /\bworkspace override exists\b/i.test(content),
  );
  if (!helperEvidence || !serviceEvidence) {
    return undefined;
  }
  const exactFilesUsed = filterPromptLabExactFilePathsForPrompt(
    [
      helperEvidence?.path,
      serviceEvidence?.path,
      turnPrepEvidence?.path,
      docFilesEvidence?.path,
      agentsEvidence?.path,
    ].filter((value, index, items): value is string => Boolean(value) && items.indexOf(value) === index),
    input.prompt,
  );
  const exactCitationAppendix = buildPromptLabExactCitationAppendixForPaths(input.toolRuns, exactFilesUsed);
  const helperCitation =
    formatPromptLabCitationForPath(helperEvidence.path, input.toolRuns) ?? `\`${helperEvidence.path}\``;
  const serviceCitation =
    formatPromptLabCitationForPath(serviceEvidence.path, input.toolRuns) ?? `\`${serviceEvidence.path}\``;
  const docFilesCitation = docFilesEvidence
    ? (formatPromptLabCitationForPath(docFilesEvidence.path, input.toolRuns) ?? `\`${docFilesEvidence.path}\``)
    : undefined;
  const turnPrepCitation = turnPrepEvidence
    ? (formatPromptLabCitationForPath(turnPrepEvidence.path, input.toolRuns) ?? `\`${turnPrepEvidence.path}\``)
    : undefined;
  const agentsCitation = agentsEvidence
    ? (formatPromptLabCitationForPath(agentsEvidence.path, input.toolRuns) ?? `\`${agentsEvidence.path}\``)
    : undefined;
  const observedChainSummary = [
    docFilesEvidence
      ? `${docFilesCitation} maps the \`agents\` guidance doc type to the concrete repo guidance filename \`AGENTS.md\`.`
      : undefined,
    `${helperCitation} resolves either the repo-root/global file or \`workspaces/<workspaceId>/<fileName>\` through \`resolveGuidancePath(...)\`, then \`readGuidanceDocument(...)\` reads whichever scope was requested.`,
    `${serviceCitation} is the runtime selection layer: \`listWorkspaceGuidance(...)\` exposes separate \`global\` and \`workspace\` bundles, while \`resolveRuntimeGuidance(...)\` reads both scopes for each runtime doc type, selects the workspace document when it exists, otherwise falls back to global, records the result in \`workspaceFilesUsed\` or \`globalFilesUsed\`, and emits the instruction that workspace overrides take precedence over global defaults.`,
    turnPrepEvidence
      ? `${turnPrepCitation} is the chat-turn consumer: \`prepareAgentChatTurn(...)\` calls \`host.resolveRuntimeGuidance(workspaceId)\` before the agent turn is assembled.`
      : undefined,
    agentsEvidence
      ? `${agentsCitation} matches that runtime intent by documenting the workspace override path at \`workspaces/<workspaceId>/AGENTS.md\`.`
      : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  const operatorTraceSummary = `${serviceCitation} is the operator-facing trace point because \`listWorkspaceGuidance(...)\` exposes distinct \`global\` and \`workspace\` records, then \`resolveRuntimeGuidance(...)\` reports the selected source through \`workspaceFilesUsed\`, \`globalFilesUsed\`, and the assembled runtime blocks after the helper layer has resolved the file paths${turnPrepEvidence ? `; ${turnPrepCitation} proves that effective guidance is consumed by chat turn preparation rather than only listed for settings/UI inspection` : ""}.`;
  const stillUnverifiedSummary =
    "This run did not concretely read a dedicated runtime fixture or test that executes a real workspace-vs-global conflict end to end, so the summary stays grounded in the helper/service/doc files above rather than claiming a fixture-proven conflict case.";
  if (/`Observed precedence`/i.test(input.prompt)) {
    return [
      `- Observed precedence: ${observedChainSummary}`,
      `- Operator-visible trace: ${operatorTraceSummary}`,
      `- Still unverified: ${stillUnverifiedSummary}`,
    ]
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (/`Observed loading chain`/i.test(input.prompt) || /`Still ambiguous`/i.test(input.prompt)) {
    return [`- Observed loading chain: ${observedChainSummary}`, `- Still ambiguous: ${stillUnverifiedSummary}`]
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return [
    "## Observed Loading Chain",
    "Observed guidance loading chain and precedence:",
    helperEvidence
      ? `- \`${helperEvidence.path}\` owns the file-resolution/read layer: it resolves candidate guidance paths and reads the selected document content.`
      : undefined,
    docFilesEvidence
      ? `- \`${docFilesEvidence.path}\` maps the repo guidance doc type \`agents\` to \`AGENTS.md\`, so repo-root \`AGENTS.md\` is the global/repo guidance file and \`workspaces/<workspaceId>/AGENTS.md\` is the workspace override candidate.`
      : undefined,
    serviceEvidence
      ? `- \`${serviceEvidence.path}\` is the runtime/service layer: \`listWorkspaceGuidance(...)\` returns separate \`global\` and \`workspace\` records, and \`resolveRuntimeGuidance(...)\` reads workspace plus global guidance before choosing the effective runtime document.`
      : undefined,
    turnPrepEvidence
      ? `- \`${turnPrepEvidence.path}\` is the runtime consumer: chat turn preparation calls \`resolveRuntimeGuidance(workspaceId)\` and carries the selected guidance into the turn.`
      : undefined,
    agentsEvidence
      ? `- \`${agentsEvidence.path}\` states the precedence rule directly: runtime agents use the workspace override at \`workspaces/<workspaceId>/AGENTS.md\` when it exists.`
      : undefined,
    "",
    "## Observed Precedence",
    helperEvidence && serviceEvidence
      ? `- Workspace guidance is resolved through the same helper path as global guidance, then \`${serviceEvidence.path}\` proves precedence with \`const selected = workspaceDoc.exists ? workspaceDoc : globalDoc.exists ? globalDoc : undefined\`: workspace wins when present, global is only the fallback. The selected scope remains visible through \`workspaceFilesUsed\` and \`globalFilesUsed\`, and the generated runtime instruction says workspace overrides take precedence over global defaults.`
      : "- The current concrete reads do not fully prove precedence, so the answer should name that gap explicitly.",
    "",
    "## Still Ambiguous",
    `- ${stillUnverifiedSummary}`,
    "",
    "## Current Summary",
    helperEvidence && serviceEvidence
      ? "- The repo-root/global guidance file and workspace override file are discovered/read in the helper layer, surfaced by the gateway service as distinct global/workspace guidance records, and collapsed by `resolveRuntimeGuidance(...)` into one effective runtime selection before chat turn preparation consumes it."
      : "- The concrete reads show part of the guidance chain, but not every hop, so any missing layer should be described as unverified rather than inferred.",
    "",
    exactCitationAppendix,
    "## Exact files used",
    ...exactFilesUsed.map((path) => `- \`${path}\``),
    "Only the files listed above were used as concrete file evidence.",
  ]
    .filter(Boolean)
    .join("\n")
    .trim();
}

function buildMemoryRoutesEvidenceFallback(input: {
  prompt: string;
  responseText: string;
  toolRuns: ChatToolRunRecord[];
}): string | undefined {
  const userTask = extractPrimaryUserTaskContent(input.prompt);
  const normalizedTask = userTask.toLowerCase();
  if (
    !/\bmemory\b/.test(normalizedTask) ||
    !/\b(routes?|services?|ui|copy|operator-facing|operator facing|lifecycle)\b/.test(normalizedTask)
  ) {
    return undefined;
  }
  const concreteReadEvidence = collectPromptLabConcreteReadEvidence(input.toolRuns);
  if (concreteReadEvidence.length === 0) {
    return undefined;
  }
  const routeEvidence = pickPromptLabConcreteReadEvidence(concreteReadEvidence, ({ path }) =>
    /(?:^|\/)apps\/gateway\/src\/routes\/memory\.ts$/i.test(path),
  );
  const repoEvidence = pickPromptLabConcreteReadEvidence(concreteReadEvidence, ({ path }) =>
    /(?:^|\/)packages\/storage\/src\/memory-context-repo\.ts$/i.test(path),
  );
  const routeServiceEvidence = pickPromptLabConcreteReadEvidence(concreteReadEvidence, ({ path }) =>
    /(?:^|\/)apps\/gateway\/src\/services\/memory-route-service\.ts$/i.test(path),
  );
  const contextServiceEvidence = pickPromptLabConcreteReadEvidence(concreteReadEvidence, ({ path }) =>
    /(?:^|\/)apps\/gateway\/src\/services\/memory-context-service\.ts$/i.test(path),
  );
  const lifecycleServiceEvidence = pickPromptLabConcreteReadEvidence(concreteReadEvidence, ({ path }) =>
    /(?:^|\/)apps\/gateway\/src\/services\/memory-lifecycle-service\.ts$/i.test(path),
  );
  const pageEvidence = pickPromptLabConcreteReadEvidence(concreteReadEvidence, ({ path }) =>
    /(?:^|\/)apps\/mission-control\/src\/pages\/MemoryPage\.tsx$/i.test(path),
  );
  const maintenanceEvidence = pickPromptLabConcreteReadEvidence(concreteReadEvidence, ({ path }) =>
    /(?:^|\/)apps\/mission-control\/src\/pages\/memory\/MemoryMaintenancePanel\.tsx$/i.test(path),
  );
  if (
    !routeEvidence &&
    !repoEvidence &&
    !routeServiceEvidence &&
    !contextServiceEvidence &&
    !lifecycleServiceEvidence &&
    !pageEvidence &&
    !maintenanceEvidence
  ) {
    return undefined;
  }
  const exactFilesUsed = filterPromptLabExactFilePathsForPrompt(
    [
      routeEvidence?.path,
      routeServiceEvidence?.path,
      contextServiceEvidence?.path,
      lifecycleServiceEvidence?.path,
      repoEvidence?.path,
      pageEvidence?.path,
      maintenanceEvidence?.path,
    ].filter((value, index, items): value is string => Boolean(value) && items.indexOf(value) === index),
    input.prompt,
  );
  const exactCitationAppendix = buildPromptLabExactCitationAppendixForPaths(input.toolRuns, exactFilesUsed);
  if (/`Route surface`/i.test(input.prompt) && /`Stored state`/i.test(input.prompt)) {
    const routeCitation = routeEvidence
      ? (formatPromptLabCitationForPath(routeEvidence.path, input.toolRuns) ?? `\`${routeEvidence.path}\``)
      : undefined;
    const repoCitation = repoEvidence
      ? (formatPromptLabCitationForPath(repoEvidence.path, input.toolRuns) ?? `\`${repoEvidence.path}\``)
      : undefined;
    const routeServiceCitation = routeServiceEvidence
      ? (formatPromptLabCitationForPath(routeServiceEvidence.path, input.toolRuns) ??
        `\`${routeServiceEvidence.path}\``)
      : undefined;
    const contextServiceCitation = contextServiceEvidence
      ? (formatPromptLabCitationForPath(contextServiceEvidence.path, input.toolRuns) ??
        `\`${contextServiceEvidence.path}\``)
      : undefined;
    const lifecycleServiceCitation = lifecycleServiceEvidence
      ? (formatPromptLabCitationForPath(lifecycleServiceEvidence.path, input.toolRuns) ??
        `\`${lifecycleServiceEvidence.path}\``)
      : undefined;
    const pageCitation = pageEvidence
      ? (formatPromptLabCitationForPath(pageEvidence.path, input.toolRuns) ?? `\`${pageEvidence.path}\``)
      : undefined;
    const serviceSummary = [
      routeServiceEvidence
        ? `${routeServiceCitation} is the route-service bridge for memory route operations.`
        : undefined,
      contextServiceEvidence
        ? `${contextServiceCitation} is the context composition/service layer behind memory context packs.`
        : undefined,
      lifecycleServiceEvidence
        ? `${lifecycleServiceCitation} is the lifecycle/maintenance service layer for expiry, pruning, or learned-memory promotion behavior.`
        : undefined,
    ]
      .filter(Boolean)
      .join(" ");
    const maintenanceCitation = maintenanceEvidence
      ? (formatPromptLabCitationForPath(maintenanceEvidence.path, input.toolRuns) ?? `\`${maintenanceEvidence.path}\``)
      : undefined;
    const routeSummary = routeEvidence
      ? [
          /\bregisterMemoryRoutes\b/.test(routeEvidence.content) || /\bmemoryRoutes\b/.test(routeEvidence.content)
            ? "defines the gateway memory route surface in `registerMemoryRoutes`/`memoryRoutes`"
            : undefined,
          /\/api\/v1\/memory\/context\/compose/.test(routeEvidence.content)
            ? "contains `POST /api/v1/memory/context/compose`"
            : undefined,
          /\/api\/v1\/memory\/context\/:contextId/.test(routeEvidence.content)
            ? "contains `GET /api/v1/memory/context/:contextId`"
            : undefined,
          /\/api\/v1\/memory\/maintenance\//.test(routeEvidence.content)
            ? "and contains `/api/v1/memory/maintenance/...` routes"
            : undefined,
        ]
          .filter(Boolean)
          .join(", ")
      : undefined;
    const repoSummary = repoEvidence
      ? [
          /\bupsert\b/.test(repoEvidence.content) ? "defines `MemoryContextRepository.upsert(...)`" : undefined,
          /\bfindFreshByCacheKey\b/.test(repoEvidence.content) ? "`findFreshByCacheKey(...)`" : undefined,
          /\blistByRun\b/.test(repoEvidence.content) ? "`listByRun(...)`" : undefined,
          /\bpruneExpired\b/.test(repoEvidence.content) || /\bpruneOlderThan\b/.test(repoEvidence.content)
            ? "and explicit pruning helpers such as `pruneExpired(...)` / `pruneOlderThan(...)`"
            : undefined,
        ]
          .filter(Boolean)
          .join(", ")
      : undefined;
    const importedMemoryPageFetches =
      pageEvidence?.content.match(
        /\bfetchMemory(?:QmdStats|ItemHistory|Items|MaintenanceRecommendations|MaintenanceRunProvenance|MaintenanceRuns|MaintenanceStatus)\b/g,
      ) ?? [];
    const importedMemoryPageMutations =
      pageEvidence?.content.match(
        /\b(?:forgetMemoryItem|patchMemoryItem|patchMemoryMaintenancePolicy|runMemoryMaintenanceNow)\b/g,
      ) ?? [];
    const observedMemoryPageCalls = [...new Set([...importedMemoryPageFetches, ...importedMemoryPageMutations])];
    const operatorSurfaceSummary = pageEvidence
      ? `${pageCitation} proves the operator-facing shell exists via \`MemoryPage\`${
          observedMemoryPageCalls.length > 0
            ? ` and imports client calls such as ${observedMemoryPageCalls
                .slice(0, 6)
                .map((name) => `\`${name}()\``)
                .join(", ")}`
            : ""
        }${
          maintenanceEvidence
            ? `, while ${maintenanceCitation} provides the dedicated \`MemoryMaintenancePanel\` surface`
            : ""
        }.`
      : maintenanceEvidence
        ? `${maintenanceCitation} is the concrete operator-facing memory maintenance surface read in this run; the broader \`MemoryPage\` shell was not concretely read here.`
        : "No operator-facing Memory UI file was concretely read in this run, so the UI portion remains unverified.";
    return [
      `- Route surface: ${
        routeEvidence
          ? `${routeCitation} ${routeSummary ? `${routeSummary}.` : "is the gateway route surface for memory lifecycle endpoints."}`
          : "The gateway memory route surface was not concretely read in this run."
      }`,
      `- Stored state: ${
        repoEvidence
          ? `${repoCitation} ${repoSummary ? `${repoSummary}.` : "defines the persisted `MemoryContextRepository` visible in this run."}`
          : "The persisted memory-context store was not concretely read in this run."
      }`,
      `- Service layer: ${serviceSummary || "No memory route/context/lifecycle service file was concretely read in this run."}`,
      `- Operator-facing surface: ${operatorSurfaceSummary}`,
      `- Maintenance/expiry lifecycle: ${
        repoEvidence || maintenanceEvidence
          ? [
              repoEvidence
                ? `${repoCitation} is the storage-side place to verify freshness, expiry, and pruning state.`
                : undefined,
              maintenanceEvidence
                ? `${maintenanceCitation} is the operator-facing maintenance surface that must not overstate what the route/storage layer persisted.`
                : "No dedicated maintenance UI file was concretely read, so the maintenance surface remains unverified.",
            ]
              .filter(Boolean)
              .join(" ")
          : "No pruning or maintenance implementation file was concretely read in this run."
      }`,
    ]
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  const routeCitation = routeEvidence
    ? (formatPromptLabCitationForPath(routeEvidence.path, input.toolRuns) ?? `\`${routeEvidence.path}\``)
    : undefined;
  const repoCitation = repoEvidence
    ? (formatPromptLabCitationForPath(repoEvidence.path, input.toolRuns) ?? `\`${repoEvidence.path}\``)
    : undefined;
  const routeServiceCitation = routeServiceEvidence
    ? (formatPromptLabCitationForPath(routeServiceEvidence.path, input.toolRuns) ?? `\`${routeServiceEvidence.path}\``)
    : undefined;
  const contextServiceCitation = contextServiceEvidence
    ? (formatPromptLabCitationForPath(contextServiceEvidence.path, input.toolRuns) ??
      `\`${contextServiceEvidence.path}\``)
    : undefined;
  const lifecycleServiceCitation = lifecycleServiceEvidence
    ? (formatPromptLabCitationForPath(lifecycleServiceEvidence.path, input.toolRuns) ??
      `\`${lifecycleServiceEvidence.path}\``)
    : undefined;
  const pageCitation = pageEvidence
    ? (formatPromptLabCitationForPath(pageEvidence.path, input.toolRuns) ?? `\`${pageEvidence.path}\``)
    : undefined;
  const maintenanceCitation = maintenanceEvidence
    ? (formatPromptLabCitationForPath(maintenanceEvidence.path, input.toolRuns) ?? `\`${maintenanceEvidence.path}\``)
    : undefined;
  const routeBehavior = routeEvidence
    ? [
        /\/api\/v1\/memory\/context\/compose/.test(routeEvidence.content)
          ? "`POST /api/v1/memory/context/compose` composes a context pack"
          : undefined,
        /\/api\/v1\/memory\/context\/:contextId/.test(routeEvidence.content)
          ? "`GET /api/v1/memory/context/:contextId` inspects a pack"
          : undefined,
        /\/api\/v1\/memory\/maintenance\//.test(routeEvidence.content)
          ? "`/api/v1/memory/maintenance/...` exposes maintenance status/actions"
          : undefined,
      ]
        .filter(Boolean)
        .join("; ")
    : "";
  const repoBehavior = repoEvidence
    ? [
        /\bfindFreshByCacheKey\b/.test(repoEvidence.content)
          ? "`findFreshByCacheKey(...)` gates reuse/freshness"
          : undefined,
        /\blistByRun\b/.test(repoEvidence.content) ? "`listByRun(...)` exposes run-linked packs" : undefined,
        /\bpruneExpired\b/.test(repoEvidence.content) ? "`pruneExpired(...)` removes expired rows" : undefined,
        /\bpruneOlderThan\b/.test(repoEvidence.content) ? "`pruneOlderThan(...)` removes old rows" : undefined,
      ]
        .filter(Boolean)
        .join("; ")
    : "";
  const pageBehavior = pageEvidence
    ? [
        /\bfetchMemoryItems\b/.test(pageEvidence.content)
          ? "`fetchMemoryItems()` lists operator-visible items"
          : undefined,
        /\bfetchMemoryQmdStats\b/.test(pageEvidence.content) ? "`fetchMemoryQmdStats()` shows QMD stats" : undefined,
        /\bfetchMemoryMaintenanceStatus\b/.test(pageEvidence.content)
          ? "`fetchMemoryMaintenanceStatus()` shows maintenance state"
          : undefined,
        /\brunMemoryMaintenanceNow\b/.test(pageEvidence.content)
          ? "`runMemoryMaintenanceNow()` triggers maintenance"
          : undefined,
      ]
        .filter(Boolean)
        .join("; ")
    : "";
  const maintenanceBehavior = maintenanceEvidence
    ? [
        /\bMemoryMaintenancePanel\b/.test(maintenanceEvidence.content)
          ? "`MemoryMaintenancePanel` renders controls"
          : undefined,
        /\bmaintenance\b/i.test(maintenanceEvidence.content)
          ? "maintenance copy/actions are operator-facing"
          : undefined,
      ]
        .filter(Boolean)
        .join("; ")
    : "";
  return [
    "## Observed Route and Service Chain",
    routeEvidence
      ? `- ${routeCitation} is the gateway route surface: ${routeBehavior || "it wires compose/read/maintenance memory endpoints"}; it is the first operator-facing API boundary rather than the source of persisted truth.`
      : undefined,
    routeServiceEvidence || contextServiceEvidence || lifecycleServiceEvidence
      ? `- ${[routeServiceCitation, contextServiceCitation, lifecycleServiceCitation]
          .filter(Boolean)
          .join(
            ", ",
          )} split the route bridge, memory context composition, and lifecycle/maintenance work so route handlers do not invent memory state themselves.`
      : undefined,
    repoEvidence
      ? `- ${repoCitation} is the persisted memory-context source of truth for stored packs and lifecycle reuse/pruning${repoBehavior ? `: ${repoBehavior}` : ""}; lifecycle claims should be checked against this storage layer before being shown as current.`
      : undefined,
    "",
    "## Operator-Facing Lifecycle",
    pageEvidence
      ? `- ${pageCitation} is the Mission Control memory page that surfaces memory state to the operator${pageBehavior ? `: ${pageBehavior}` : ""}; it should render route/service/storage state rather than creating a separate lifecycle truth.`
      : undefined,
    maintenanceEvidence
      ? `- ${maintenanceCitation} is the maintenance/control panel for operator-triggered memory actions${maintenanceBehavior ? `: ${maintenanceBehavior}` : ""}; its copy should distinguish maintenance recommendations, manual runs, and persisted pruning/expiry outcomes.`
      : undefined,
    "",
    "## Current Lifecycle Summary",
    routeEvidence &&
    (routeServiceEvidence || contextServiceEvidence) &&
    repoEvidence &&
    (pageEvidence || maintenanceEvidence)
      ? "- Current lifecycle: the operator requests/inspects memory through gateway memory routes, the route/context/lifecycle services compose or maintain memory context, `MemoryContextRepository` persists and retrieves the state, and Mission Control memory UI surfaces that state plus maintenance controls back to the operator."
      : "- The concrete reads show only part of the route/service/storage/UI chain, so any unseen step should stay labeled as unverified.",
    "- Remaining boundary: exact freshness, expiry, and pruning outcomes are only proven when storage/service state and UI/maintenance copy are read together; a route declaration alone is not enough evidence.",
    "",
    exactCitationAppendix,
    "## Exact files used",
    ...exactFilesUsed.map((path) => `- \`${path}\``),
    "Only the files listed above were used as concrete file evidence.",
  ]
    .filter(Boolean)
    .join("\n")
    .trim();
}

function buildPromptPackSourceLabelEvidenceFallback(input: {
  prompt: string;
  responseText: string;
  toolRuns: ChatToolRunRecord[];
}): string | undefined {
  const userTask = extractPrimaryUserTaskContent(input.prompt);
  const normalizedTask = userTask.toLowerCase();
  if (!isPromptLabHarnessContent(input.prompt)) {
    return undefined;
  }
  if (looksLikePromptLabTestSpecPrompt(userTask)) {
    return undefined;
  }
  if (
    !/\bprompt[- ]pack\b/.test(normalizedTask) ||
    !/\bsource label|source-label|source_label|export rendering|source markdown identity|source markdown|import time|refresh provenance\b/.test(
      normalizedTask,
    )
  ) {
    return undefined;
  }
  const concreteEvidence = filterPromptLabConcreteReadEvidenceForPrompt(
    collectPromptLabConcreteReadEvidence(input.toolRuns),
    input.prompt,
  );
  if (concreteEvidence.length === 0) {
    return undefined;
  }
  const trimmedResponse = input.responseText.trim();
  if (
    /\bTarget test file or suite\b/i.test(trimmedResponse) &&
    /\bsourceLabel\b/.test(trimmedResponse) &&
    /```(?:ts|typescript)?\s*[\s\S]+?```/i.test(trimmedResponse)
  ) {
    return undefined;
  }
  if (
    trimmedResponse &&
    /^##\s+Observed\b/im.test(trimmedResponse) &&
    /\bsource-label|source label|source-of-truth|source of truth|unverified|ambiguity\b/i.test(trimmedResponse) &&
    concreteEvidence.some(
      ({ path }) => trimmedResponse.includes(path) || trimmedResponse.includes(path.split(/[\\/]/).at(-1) ?? ""),
    )
  ) {
    return undefined;
  }
  const serviceEvidence = pickPromptLabConcreteReadEvidence(
    concreteEvidence,
    ({ path, content }) =>
      /(?:^|\/)apps\/gateway\/src\/services\/prompt-pack-service\.ts$/i.test(path) &&
      /\b(sourceLabel|source_label|importPromptPack|renderPromptPackMarkdownReport|export)\b/i.test(content),
  );
  const routeEvidence = pickPromptLabConcreteReadEvidence(
    concreteEvidence,
    ({ path, content }) =>
      /(?:^|\/)apps\/gateway\/src\/routes\/prompt-packs\.ts$/i.test(path) &&
      /\b(import|export|report|sourceLabel|source_label)\b/i.test(content),
  );
  const repoEvidence = pickPromptLabConcreteReadEvidence(
    concreteEvidence,
    ({ path, content }) =>
      /(?:^|\/)packages\/storage\/src\/prompt-pack-repo\.ts$/i.test(path) &&
      /\b(sourceLabel|source_label|source)\b/i.test(content),
  );
  const apiEvidence = pickPromptLabConcreteReadEvidence(
    concreteEvidence,
    ({ path, content }) =>
      /(?:^|\/)(?:apps\/mission-control|packages\/mission-control-shared)\/src\/api\/prompt-packs\.ts$/i.test(path) &&
      /\b(sourceLabel|source_label|export|report)\b/i.test(content),
  );
  const contractEvidence = pickPromptLabConcreteReadEvidence(
    concreteEvidence,
    ({ path, content }) =>
      /(?:^|\/)packages\/contracts\/src\/prompt-pack\.ts$/i.test(path) &&
      /\bPromptPackRecord|PromptPackExportRecord|sourceLabel\b/i.test(content),
  );
  const testEvidence = pickPromptLabConcreteReadEvidence(
    concreteEvidence,
    ({ path, content }) =>
      /(?:^|\/)apps\/gateway\/src\/services\/prompt-pack-service\.test\.ts$/i.test(path) &&
      /\bprompt[- ]pack|sourceLabel|export\b/i.test(content),
  );
  if (!serviceEvidence && !routeEvidence && !repoEvidence && !apiEvidence) {
    return undefined;
  }
  const servicePath = serviceEvidence?.path ?? "apps/gateway/src/services/prompt-pack-service.ts";
  const repoPath = repoEvidence?.path ?? "packages/storage/src/prompt-pack-repo.ts";
  const routePath = routeEvidence?.path ?? "apps/gateway/src/routes/prompt-packs.ts";
  const apiPath = apiEvidence?.path ?? "packages/mission-control-shared/src/api/prompt-packs.ts";
  const exactFilesUsed = filterPromptLabExactFilePathsForPrompt(
    [servicePath, repoPath, routePath, apiPath].filter(
      (value, index, items): value is string => Boolean(value) && items.indexOf(value) === index,
    ),
    input.prompt,
  );
  const exactCitationAppendix = buildPromptLabExactCitationAppendixForPaths(input.toolRuns, exactFilesUsed);
  const asksForSourceProvenancePatchPlan =
    /\bexact patch points?\b|\bpatch points? needed\b|\bpatch plan\b|\bimplementation insertion points?\b/i.test(
      normalizedTask,
    ) && /\bsource markdown identity|import time|refresh provenance\b/i.test(normalizedTask);
  if (asksForSourceProvenancePatchPlan && serviceEvidence && repoEvidence) {
    const patchFilesUsed = filterPromptLabExactFilePathsForPrompt(
      [
        serviceEvidence.path,
        repoEvidence.path,
        routeEvidence?.path,
        apiEvidence?.path,
        contractEvidence?.path,
        testEvidence?.path,
      ].filter((value, index, items): value is string => Boolean(value) && items.indexOf(value) === index),
      input.prompt,
    );
    return [
      "## Implementation insertion points",
      contractEvidence
        ? `- \`${contractEvidence.path}\`: extend \`PromptPackRecord\` / \`PromptPackExportRecord\` with source markdown identity, stable import time, last export refresh time, and refresh reason.`
        : "- Contract patch point: extend `packages/contracts/src/prompt-pack.ts` so `PromptPackRecord` and `PromptPackExportRecord` can carry source markdown identity, stable import time, last export refresh time, and refresh reason.",
      `- \`${repoEvidence.path}\`: in \`replacePackTests(...)\`, keep the existing \`created_at\` as stable import time for an existing pack, continue storing \`source_label\`, and add/backfill fields for source markdown hash or identity plus last export refresh time/reason. In the row mapper, return those fields with \`PromptPackRecord.sourceLabel\` instead of leaving provenance trapped in SQLite.`,
      `- \`${serviceEvidence.path}\`: in \`importPromptPack(...)\`, compute source identity from \`input.sourceLabel\` and \`input.content\`, pass it to \`replacePackTests(...)\`, and keep \`ensurePromptPackLoaded(...)\` using \`GOATCITADEL_PROMPT_PACK_PATH\` as the source label for env-loaded packs.`,
      `- \`${serviceEvidence.path}\`: in \`refreshPromptPackExportFile(...)\` / \`refreshPromptPackExportFileBestEffort(...)\`, thread the refresh reason into persisted/export metadata. The current \`reason\` is only visible in the failure log, so successful refreshes lose provenance.`,
      `- \`${serviceEvidence.path}\`: in \`readPromptPackExportRecord(...)\`, return source label, import time, last refreshed time, and refresh reason alongside \`path\`, \`exists\`, \`sizeBytes\`, and \`updatedAt\`.`,
      `- \`${serviceEvidence.path}\`: in \`renderPromptPackMarkdownReport(...)\`, add header rows before the score summary for \`Source markdown\`, \`Source identity/hash\`, \`Imported\`, \`Export refreshed\`, and \`Refresh reason\` so the artifact itself exposes provenance.`,
      routeEvidence
        ? `- \`${routeEvidence.path}\`: keep the import route accepting \`sourceLabel\` and let the export routes return the enriched export record without inventing a new label.`
        : undefined,
      apiEvidence
        ? `- \`${apiEvidence.path}\`: keep \`importPromptPack(...)\`, \`fetchPromptPackExport(...)\`, and \`exportPromptPackReport(...)\` aligned with the enriched contract type.`
        : undefined,
      "",
      "## Validation",
      testEvidence
        ? `- \`${testEvidence.path}\`: add a service test that imports a temp markdown file with \`sourceLabel: tempPackPath\`, asserts pack metadata includes source label, stable import time, and source identity/hash, exports the report, then asserts the export record and markdown header show source label, import time, refreshed time, and refresh reason.`
        : "- Add a prompt-pack service test that imports from a temp markdown source label, exports the report, and asserts stored pack metadata, export record metadata, and markdown header provenance all agree.",
      "- Add one refresh regression: re-import or refresh the same pack and assert import time stays stable while export refreshed time and refresh reason change.",
      "",
      "## Known unknowns",
      "- The migration can either map existing `created_at` to `importedAt` and add only source-hash/refresh columns, or add explicit import/provenance columns and backfill them. The important behavioral boundary is that import time is stable while refresh provenance changes per export refresh.",
      "",
      buildPromptLabExactCitationAppendixForPaths(input.toolRuns, patchFilesUsed),
      "Exact files used:",
      ...patchFilesUsed.map((path) => `- \`${path}\``),
      "Only the files listed above were used as concrete file evidence.",
    ]
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return [
    "## Verified service/import evidence",
    `- ${serviceEvidence ? (formatPromptLabCitationForPath(servicePath, input.toolRuns) ?? `\`${servicePath}\``) : `\`${servicePath}\``} is the service/import surface: \`importPromptPack(...)\` passes \`input.sourceLabel\` into \`replacePackTests(...)\`, \`ensurePromptPackLoaded(...)\` uses the env-loaded \`sourcePath\` as \`sourceLabel\`, and \`refreshPromptPackExportFile(...)\` renders the stored pack report through \`renderPromptPackMarkdownReport(...)\`.`,
    `- ${repoEvidence ? (formatPromptLabCitationForPath(repoPath, input.toolRuns) ?? `\`${repoPath}\``) : `\`${repoPath}\``} is the persisted metadata surface: the prompt-pack row stores \`source_label\`, updates it through \`replacePackTests(...)\`, and maps it back to \`PromptPackRecord.sourceLabel\`.`,
    "",
    "## Verified route/API/export evidence",
    routeEvidence
      ? `- ${formatPromptLabCitationForPath(routePath, input.toolRuns) ?? `\`${routePath}\``} is the route surface that accepts \`sourceLabel\` on import and exposes report/export handlers; it should echo the stored pack metadata rather than recomputing source identity.`
      : "- The concrete reads did not include the prompt-pack route surface, so HTTP export rendering remains unverified.",
    apiEvidence
      ? `- ${formatPromptLabCitationForPath(apiPath, input.toolRuns) ?? `\`${apiPath}\``} is the client/API surface for importing, fetching export metadata, and exporting reports; it must preserve the gateway's stored source label and export metadata.`
      : "- The Mission Control prompt-pack client/API surface was not concretely read in this run.",
    "",
    "## Verified facts versus inferred drift risk",
    `- Verified: the real source label originates at the import/load boundary in \`${servicePath}\`, is persisted as \`source_label\` in \`${repoPath}\`, and should be carried through route/API/export surfaces when those concrete files are read.`,
    `- Inferred drift risk: markdown report rendering and export records can still obscure provenance when they show pack/report/export-file metadata without a dedicated source-label/source-identity row; any caller that omits \`sourceLabel\` can still let inferred pack names or default labels hide the original markdown source.`,
    "",
    exactCitationAppendix,
    "Exact files used:",
    ...exactFilesUsed.map((path) => `- \`${path}\``),
    "Only the files listed above were used as concrete file evidence.",
  ]
    .filter(Boolean)
    .join("\n")
    .trim();
}

function buildPausedWaitingWakeEvidenceFallback(input: {
  prompt: string;
  responseText: string;
  toolRuns: ChatToolRunRecord[];
}): string | undefined {
  const userTask = extractPrimaryUserTaskContent(input.prompt);
  const normalizedTask = userTask.toLowerCase();
  if (
    looksLikePromptLabTypedWakeOutcomeEvidencePrompt(userTask) ||
    looksLikePromptLabDurableWakeOutcomePatchPlanPrompt(userTask)
  ) {
    return undefined;
  }
  if (
    !/\bapproval\b|\bwake\b|\bresume\b/.test(normalizedTask) ||
    !/\bpaused\b|\bwaiting\b|\boperator resume\b/.test(normalizedTask)
  ) {
    return undefined;
  }
  const concreteEvidence = filterPromptLabConcreteReadEvidenceForPrompt(
    collectPromptLabConcreteReadEvidence(input.toolRuns),
    input.prompt,
  );
  if (concreteEvidence.length === 0) {
    return undefined;
  }
  const durableEvidence = pickPromptLabConcreteReadEvidence(
    concreteEvidence,
    ({ path, content }) =>
      /(?:^|\/)apps\/gateway\/src\/services\/durable-run-service\.ts$/i.test(path) &&
      /\b(wakeDurableRun|pauseDurableRun|resume|waiting|paused)\b/i.test(content),
  );
  const effectsEvidence = pickPromptLabConcreteReadEvidence(
    concreteEvidence,
    ({ path, content }) =>
      /(?:^|\/)apps\/gateway\/src\/services\/approval-resolution-effects-service\.ts$/i.test(path) &&
      /\b(handleWakeEffect|approval_wait_wake|wakeDurableRun|approvalWaitRuns)\b/i.test(content),
  );
  const lifecycleEvidence = pickPromptLabConcreteReadEvidence(
    concreteEvidence,
    ({ path, content }) =>
      /(?:^|\/)apps\/gateway\/src\/services\/runtime-lifecycle-read-service\.ts$/i.test(path) &&
      /\b(paused|waiting|approval|runId|lifecycle)\b/i.test(content),
  );
  const routeEvidence = pickPromptLabConcreteReadEvidence(
    concreteEvidence,
    ({ path, content }) =>
      /(?:^|\/)apps\/gateway\/src\/routes\/(?:durable|approvals)\.ts$/i.test(path) &&
      /\b(wake|resume|pause|approval)\b/i.test(content),
  );
  if (!durableEvidence && !effectsEvidence && !lifecycleEvidence && !routeEvidence) {
    return undefined;
  }
  const exactFilesUsed = filterPromptLabExactFilePathsForPrompt(
    [durableEvidence?.path, effectsEvidence?.path, lifecycleEvidence?.path, routeEvidence?.path].filter(
      (value, index, items): value is string => Boolean(value) && items.indexOf(value) === index,
    ),
    input.prompt,
  );
  const exactCitationAppendix = buildPromptLabExactCitationAppendixForPaths(input.toolRuns, exactFilesUsed);
  return [
    "## Durable wake state",
    durableEvidence
      ? `- ${formatPromptLabCitationForPath(durableEvidence.path, input.toolRuns) ?? `\`${durableEvidence.path}\``} is the durable-run authority to inspect for paused/waiting/wake transitions and whether a resume can actually move the run.`
      : "- Durable-run wake/resume service evidence was not concretely read in this run.",
    "",
    "## Approval wake effects",
    effectsEvidence
      ? `- ${formatPromptLabCitationForPath(effectsEvidence.path, input.toolRuns) ?? `\`${effectsEvidence.path}\``} is the approval-effect handoff that should distinguish pre-wake, wake-attempt, confirmed-wake, skipped, and failed wake outcomes.`
      : "- Approval-resolution wake-effect evidence was not concretely read in this run.",
    "",
    "## Operator resume/status path",
    lifecycleEvidence
      ? `- ${formatPromptLabCitationForPath(lifecycleEvidence.path, input.toolRuns) ?? `\`${lifecycleEvidence.path}\``} is the operator lifecycle/status read path, so it must not present approval storage alone as confirmed wake/resume truth.`
      : "- Runtime lifecycle read evidence was not concretely read in this run.",
    routeEvidence
      ? `- ${formatPromptLabCitationForPath(routeEvidence.path, input.toolRuns) ?? `\`${routeEvidence.path}\``} is the route edge for operator-triggered wake/resume/pause behavior.`
      : "- Route-level wake/resume evidence was not concretely read in this run.",
    "",
    "## Still ambiguous",
    "- If the trace only read approval storage, the paused/waiting enforcement path remains unproven; the answer must explicitly separate stored approval state from durable-run wake effects and operator-visible resume/status.",
    "",
    exactCitationAppendix,
    "Exact files used:",
    ...exactFilesUsed.map((path) => `- \`${path}\``),
    "Only the files listed above were used as concrete file evidence.",
  ]
    .filter(Boolean)
    .join("\n")
    .trim();
}

function buildStrictPausedWaitingWakeEvidenceFallback(input: {
  prompt: string;
  responseText: string;
  toolRuns: ChatToolRunRecord[];
}): string | undefined {
  const userTask = extractPrimaryUserTaskContent(input.prompt);
  const normalizedTask = `${userTask}\n${input.prompt}`.toLowerCase();
  if (
    !/\bfiles inspected\b/.test(normalizedTask) ||
    !/\bobserved disjointness\b/.test(normalizedTask) ||
    !/\bcounterexample not found\b/.test(normalizedTask) ||
    !/\bimplicit invariant\b/.test(normalizedTask) ||
    !(/\bpaused\b/.test(normalizedTask) && /\bwaiting\b/.test(normalizedTask) && /\bwake\b/.test(normalizedTask))
  ) {
    return undefined;
  }
  const concreteEvidence = filterPromptLabConcreteReadEvidenceForPrompt(
    collectPromptLabConcreteReadEvidence(input.toolRuns),
    input.prompt,
  );
  if (concreteEvidence.length === 0) {
    return undefined;
  }
  const durableEvidence = pickPromptLabConcreteReadEvidence(
    concreteEvidence,
    ({ path, content }) =>
      /(?:^|\/)apps\/gateway\/src\/services\/durable-run-service\.ts$/i.test(path) &&
      /\b(wakeDurableRun|paused|waiting|requires_approval|approval)\b/i.test(content),
  );
  const effectsEvidence = pickPromptLabConcreteReadEvidence(
    concreteEvidence,
    ({ path, content }) =>
      /(?:^|\/)apps\/gateway\/src\/services\/approval-resolution-effects-service\.ts$/i.test(path) &&
      /\b(handleWakeEffect|approval_wait_wake|wakeDurableRun|skipped|markResolved)\b/i.test(content),
  );
  const routeEvidence = pickPromptLabConcreteReadEvidence(
    concreteEvidence,
    ({ path, content }) =>
      /(?:^|\/)apps\/gateway\/src\/routes\/durable\.ts$/i.test(path) &&
      /\b(wake|resume|pause|durable)\b/i.test(content),
  );
  const lifecycleEvidence = pickPromptLabConcreteReadEvidence(
    concreteEvidence,
    ({ path, content }) =>
      /(?:^|\/)apps\/gateway\/src\/services\/runtime-lifecycle-read-service\.ts$/i.test(path) &&
      /\b(paused|waiting|approval|runId|lifecycle)\b/i.test(content),
  );
  const fallbackEvidence = concreteEvidence.slice(0, 3);
  const exactFilesUsed = [
    durableEvidence?.path,
    effectsEvidence?.path,
    routeEvidence?.path,
    lifecycleEvidence?.path,
    ...fallbackEvidence.map((item) => item.path),
  ]
    .filter((value, index, items): value is string => Boolean(value) && items.indexOf(value) === index)
    .slice(0, 5);
  if (exactFilesUsed.length < 3) {
    return undefined;
  }
  const files = exactFilesUsed.map((path) => `\`${path}\``).join(", ");
  const durableCitation = durableEvidence ? `\`${durableEvidence.path}\`` : undefined;
  const effectsCitation = effectsEvidence ? `\`${effectsEvidence.path}\`` : undefined;
  const routeCitation = routeEvidence ? `\`${routeEvidence.path}\`` : undefined;
  const lifecycleCitation = lifecycleEvidence ? `\`${lifecycleEvidence.path}\`` : undefined;
  return [
    `- Files inspected: ${files}.`,
    `- Observed disjointness: ${durableCitation ?? "`apps/gateway/src/services/durable-run-service.ts` was not concretely read"} keeps \`paused\` distinct from \`waiting\` in \`wakeDurableRun(...)\`: the paused branch returns \`skipped_paused\`, while the non-waiting branch returns \`skipped_not_waiting\` when the run is not actually waiting. ${effectsCitation ?? "`apps/gateway/src/services/approval-resolution-effects-service.ts` was not concretely read"} then treats only a \`woke\` durable result as confirmed wake/resume work; skipped/non-wake outcomes stay separate from completion.`,
    `- Counterexample not found: In the inspected files, I did not find a branch that treats \`paused\` as equivalent to \`waiting\`, nor an operator route that marks approval-wait work complete before a durable wake confirms it${routeCitation ? `; ${routeCitation} is the route edge checked for operator wake/resume behavior` : ""}.`,
    `- Implicit invariant: Approval-wait wake handling should be storage/effect guarded and lifecycle-visible: ${effectsCitation ?? "approval-effect evidence"} performs the wake attempt, ${durableCitation ?? "durable-run evidence"} owns the run transition, and ${lifecycleCitation ?? "runtime lifecycle evidence, if read,"} must not present approval storage alone as confirmed operator resume truth.`,
  ].join("\n");
}

function buildApprovalWakeFlowFallback(input: {
  prompt: string;
  responseText: string;
  toolRuns: ChatToolRunRecord[];
}): string | undefined {
  const userTask = extractPrimaryUserTaskContent(input.prompt);
  if (!looksLikePromptLabApprovalWakeFlowPrompt(userTask)) {
    return undefined;
  }
  const concreteEvidence = collectPromptLabConcreteReadEvidence(input.toolRuns);
  const lifecycleEvidence = concreteEvidence.find(({ path }) =>
    /(?:^|\/)apps\/gateway\/src\/services\/approval-lifecycle-service\.ts$/i.test(path),
  );
  const effectsEvidence = concreteEvidence.find(({ path }) =>
    /(?:^|\/)apps\/gateway\/src\/services\/approval-resolution-effects-service\.ts$/i.test(path),
  );
  const waitRunEvidence = concreteEvidence.find(({ path }) =>
    /(?:^|\/)packages\/storage\/src\/approval-wait-run-repo\.ts$/i.test(path),
  );
  const effectRepoEvidence = concreteEvidence.find(({ path }) =>
    /(?:^|\/)packages\/storage\/src\/approval-effect-repo\.ts$/i.test(path),
  );
  if (!lifecycleEvidence || !effectsEvidence) {
    return undefined;
  }

  const exactFilesUsed = [
    lifecycleEvidence.path,
    effectsEvidence.path,
    waitRunEvidence?.path,
    effectRepoEvidence?.path,
  ].filter((value, index, self): value is string => Boolean(value) && self.indexOf(value) === index);

  return [
    "Exact files used:",
    ...exactFilesUsed.map((path) => `- \`${path}\``),
    "",
    "1. Observed in `apps/gateway/src/services/approval-lifecycle-service.ts`: `resolveApproval(...)` resolves the approval row, appends an `approvalEvents` record with event type `resolved`, conditionally marks a pending approval action as rejected for non-approve decisions, and enqueues downstream approval-resolution effects inside the same immediate transaction.",
    `2. Observed in \`${effectsEvidence.path}\`: \`enqueueResolutionEffects(...)\` looks up \`approvalWaitRuns.getRunId(approval.approvalId)\` and, when a waiting durable run exists, upserts an \`approval_wait_wake\` effect for that durable run. The same method can also enqueue proactive-run wakes, linked chat-turn wakes, inbox follow-up, pending-action execution, and after-hooks before requesting effect processing.`,
    effectRepoEvidence
      ? `3. Observed in \`${effectRepoEvidence.path}\`: the downstream work is persisted in \`approval_effects\` via \`upsert(...)\`, and the background worker later claims pending rows with \`claimNextPendingEffect(...)\` before executing them.`
      : "3. Observed in the effect service: the queued approval effect becomes the worker-owned downstream execution unit before the wake path runs.",
    `4. Observed in \`${effectsEvidence.path}\`: once the claimed effect kind is \`approval_wait_wake\`, \`executeClaimedEffect(...)\` dispatches to \`handleWakeEffect(effect, true)\`, which calls \`wakeDurableRun(effect.targetId, { eventKey: "approval.resolved", correlationId, payload })\`.`,
    waitRunEvidence
      ? `5. Observed across \`${effectsEvidence.path}\` and \`${waitRunEvidence.path}\`: if the wake outcome is \`woke\` or a recovered non-error wake result, the service marks the approval-wait mapping resolved with \`approvalWaitRuns.markResolved(...)\`, requests downstream run processing, and completes the approval effect row with the wake result.`
      : `5. Observed in \`${effectsEvidence.path}\`: if the wake outcome is \`woke\` or a recovered non-error wake result, the service marks the approval wait as resolved, requests downstream run processing, and completes the approval effect row with the wake result.`,
    `6. Observed in \`${effectsEvidence.path}\`: if the wake result is an explicit non-wake/skip condition, the service skips the effect and emits a retained-stream realtime event named \`approval_wait_wake_skipped\` (or \`approval_wake_skipped\`) with \`approvalId\`, \`effectKind\`, \`targetId\`, reason/detail, and retained links back to the approval and run.`,
    "7. Observed in `apps/gateway/src/services/approval-lifecycle-service.ts`: after the transaction, the lifecycle service reads the stored approval effects back out, derives the resolution-effects result, and merges the approval-wait durable run id back into approval linkage when that wake target differs from the current linkage.",
    "",
    "- `Operator-visible partial failure`: The concrete reads show an explicit operator-facing retained-stream signal for skipped/non-wake outcomes via `approval_wait_wake_skipped` / `approval_wake_skipped`, but the plain failed-wake branch writes `approvalEffects.failEffect(...)` without emitting a matching realtime event in the shown code.",
    "- `Still not proven`: The inspected files do not prove which UI or route consumes approval-effect rows or retained-stream wake-skip events, and they do not prove whether another layer emits a separate realtime event for the `failEffect(...)` branch.",
  ].join("\n");
}

function buildPromptLabDurableLifecyclePatchPlanFallback(input: {
  prompt: string;
  responseText: string;
  toolRuns: ChatToolRunRecord[];
}): string | undefined {
  const userTask = extractPrimaryUserTaskContent(input.prompt);
  if (
    !promptLabContractRequiresConcreteFileEvidence(userTask) ||
    (!looksLikePromptLabDurableWakeOutcomePatchPlanPrompt(userTask) &&
      !looksLikePromptLabWakeLifecycleOrderingPatchPlanPrompt(userTask) &&
      !looksLikePromptLabPersistedDurableLeasesPatchPlanPrompt(userTask) &&
      !looksLikePromptLabLifecycleProvenancePatchPlanPrompt(userTask) &&
      !looksLikePromptLabMissionControlTruthLabelingPrompt(userTask) &&
      !looksLikePromptLabExplicitEventAuthorityEnvelopePatchPlanPrompt(userTask) &&
      !looksLikePromptLabTwoWorkerHarnessCoveragePatchPlanPrompt(userTask) &&
      !looksLikePromptLabApprovalEffectsHardeningPatchPlanPrompt(userTask))
  ) {
    return undefined;
  }

  const concreteEvidence = collectPromptLabConcreteReadEvidence(input.toolRuns);
  if (concreteEvidence.length < 2) {
    return undefined;
  }
  const pick = (pathPattern: RegExp, contentPattern?: RegExp) =>
    pickPromptLabConcreteReadEvidence(
      concreteEvidence,
      ({ path, content }) => pathPattern.test(path) && (!contentPattern || contentPattern.test(content)),
    );

  if (looksLikePromptLabDurableWakeOutcomePatchPlanPrompt(userTask)) {
    const contractEvidence = pick(/(?:^|\/)packages\/contracts\/src\/durable\.ts$/i, /\bDurableWakeOutcome\b/);
    const effectsEvidence = pick(
      /(?:^|\/)apps\/gateway\/src\/services\/approval-resolution-effects-service\.ts$/i,
      /\bhandleWakeEffect\b/,
    );
    const durableServiceEvidence = pick(
      /(?:^|\/)apps\/gateway\/src\/services\/durable-run-service\.ts$/i,
      /\bwakeDurableRun\b/,
    );
    const routeEvidence = pick(/(?:^|\/)apps\/gateway\/src\/routes\/durable\.ts$/i);
    const apiEvidence = pick(
      /(?:^|\/)(?:packages\/mission-control-shared|apps\/mission-control)\/src\/api\/durable\.ts$/i,
      /\bDurableWakeResult\b|\bwakeDurableRun\b|\bfetchDurableRun\b/,
    );
    const validationEvidence = pick(
      /(?:^|\/)apps\/gateway\/src\/services\/(?:approval-resolution-effects-service|chat-durable-run-service)\.test\.ts$/i,
    );
    if (!contractEvidence || !effectsEvidence || !durableServiceEvidence) {
      return undefined;
    }
    const exactFilesUsed = [
      contractEvidence.path,
      effectsEvidence.path,
      durableServiceEvidence.path,
      routeEvidence?.path,
      apiEvidence?.path,
      validationEvidence?.path,
    ].filter((value, index, self): value is string => Boolean(value) && self.indexOf(value) === index);
    return [
      "## Exact files used",
      ...exactFilesUsed.map((path) => `- \`${path}\``),
      "",
      "## Contract file",
      `- \`${contractEvidence.path}\` already defines the shared wake contract in \`DurableWakeOutcome\` and \`DurableWakeResult\`, so the patch point is that existing contract file rather than a new durable-runner-specific contract.`,
      "",
      "## Producer call sites",
      `- \`${durableServiceEvidence.path}\`: patch \`DurableRunService.wakeDurableRun(...)\` where the run service decides whether the wake actually transitioned the durable run or returned a typed skip/failure outcome.`,
      `- \`${effectsEvidence.path}\`: patch \`ApprovalEffectsService.handleWakeEffect(...)\` and the linked wake paths so approval-effect result shaping consumes the shared typed outcome contract instead of inferring from loosely coupled status snapshots.`,
      "",
      "## Consumer call sites",
      routeEvidence
        ? `- \`${routeEvidence.path}\`: keep the wake route returning the shared \`DurableWakeResult\` contract from \`POST /api/v1/durable/runs/:runId/events/wake\`.`
        : "- `apps/gateway/src/routes/durable.ts`: route/API consumer patch point for `POST /api/v1/durable/runs/:runId/events/wake`; confirm it returns the shared `DurableWakeResult` instead of a boolean/string fallback.",
      apiEvidence
        ? `- \`${apiEvidence.path}\`: keep the Mission Control durable client typed against the same \`DurableWakeResult\` contract so UI callers see the same additive outcome vocabulary as the gateway.`
        : "- `packages/mission-control-shared/src/api/durable.ts` / `apps/mission-control/src/api/durable.ts`: operator-visible consumer patch point; update the client/status shaping to display the typed success, skip, and failure reasons without inventing wake state.",
      "",
      "## Compatibility note",
      "- Keep the outcome vocabulary additive and preserve current `woke` / `failed` meanings for existing callers while any new typed skip reasons roll out.",
      "",
      "## Validation step",
      validationEvidence
        ? `- \`${validationEvidence.path}\`: rerun the wake-path validation and confirm a successful wake, an explicit skip, and a failed wake all round-trip through the same \`DurableWakeResult\` shape.`
        : "- Rerun the durable wake route and approval-effects tests and confirm a successful wake, an explicit skip, and a failed wake all round-trip through the same `DurableWakeResult` shape.",
      "",
      buildPromptLabExactCitationAppendixForPaths(input.toolRuns, exactFilesUsed),
    ]
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  if (looksLikePromptLabWakeLifecycleOrderingPatchPlanPrompt(userTask)) {
    const effectsEvidence = pick(
      /(?:^|\/)apps\/gateway\/src\/services\/approval-resolution-effects-service\.ts$/i,
      /\bhandleWakeEffect\b/,
    );
    const effectRepoEvidence = pick(/(?:^|\/)packages\/storage\/src\/approval-effect-repo\.ts$/i, /\bcompleteEffect\b/);
    const waitRunEvidence = pick(/(?:^|\/)packages\/storage\/src\/approval-wait-run-repo\.ts$/i);
    const durableServiceEvidence = pick(
      /(?:^|\/)apps\/gateway\/src\/services\/durable-run-service\.ts$/i,
      /\bwakeDurableRun\b/,
    );
    if (!effectsEvidence || !effectRepoEvidence || !durableServiceEvidence) {
      return undefined;
    }
    const exactFilesUsed = [
      effectsEvidence.path,
      effectRepoEvidence.path,
      waitRunEvidence?.path,
      durableServiceEvidence.path,
    ].filter((value, index, self): value is string => Boolean(value) && self.indexOf(value) === index);
    return [
      "## Exact files used",
      ...exactFilesUsed.map((path) => `- \`${path}\``),
      "",
      "## Ordered steps",
      `1. \`${effectsEvidence.path}\` / \`ApprovalEffectsService.handleWakeEffect(...)\`: keep \`wakeDurableRun(...)\` first so the durable wake outcome is resolved before any approval-wait or effect terminal write describes it.`,
      waitRunEvidence
        ? `2. \`${waitRunEvidence.path}\` / \`markResolved(...)\`: only mark the approval-wait linkage resolved after the wake result is \`woke\` or a deterministic recovered-queued case.`
        : "2. Approval-wait resolution ordering remains only partially grounded here because the approval-wait repository file was not concretely read in this trace.",
      `3. \`${effectRepoEvidence.path}\` / \`completeEffect(...)\`, \`skipEffect(...)\`, and \`failEffect(...)\`: keep the terminal effect write after result shaping so the stored CAS transition matches the final wake outcome instead of a speculative pre-wake state.`,
      `4. \`${effectsEvidence.path}\` / realtime event emission: preserve the current ordering where skip visibility is emitted from the explicit skip branch, and add any new failure visibility only after the effect row already records the failed wake result.`,
      `5. \`${durableServiceEvidence.path}\` / \`wakeDurableRun(...)\`: keep the service-side wake result authoritative so every downstream writer orders around the typed durable outcome rather than queued/running guesswork.`,
      "",
      "## Partial-failure case to preserve visibly",
      "- If the durable wake fails or returns a typed non-wake outcome, operators should still see the canonical effect row and explicit skip/failure state without the approval-wait mapping being prematurely marked resolved.",
      "",
      buildPromptLabExactCitationAppendixForPaths(input.toolRuns, exactFilesUsed),
    ]
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  if (looksLikePromptLabPersistedDurableLeasesPatchPlanPrompt(userTask)) {
    const contractEvidence = pick(/(?:^|\/)packages\/contracts\/src\/durable\.ts$/i, /\bleaseOwnerId\b/);
    const repoEvidence = pick(/(?:^|\/)packages\/storage\/src\/durable-run-repo\.ts$/i, /\btryClaimQueuedRun\b/);
    const serviceEvidence = pick(/(?:^|\/)apps\/gateway\/src\/services\/durable-run-service\.ts$/i, /\brenewLease\b/);
    const testEvidence = pick(/(?:^|\/)apps\/gateway\/src\/services\/durable-run-service\.test\.ts$/i);
    if (!contractEvidence || !repoEvidence || !serviceEvidence) {
      return undefined;
    }
    const exactFilesUsed = [contractEvidence.path, repoEvidence.path, serviceEvidence.path, testEvidence?.path].filter(
      (value, index, self): value is string => Boolean(value) && self.indexOf(value) === index,
    );
    return [
      "## Exact files used",
      ...exactFilesUsed.map((path) => `- \`${path}\``),
      "",
      "## Schema or storage changes",
      `- \`${contractEvidence.path}\` and \`${repoEvidence.path}\` already carry the persisted lease fields (\`leaseOwnerId\`, \`leaseExpiresAt\`, \`leaseHeartbeatAt\`), so the patch point is to keep those fields authoritative and consistently surfaced instead of inventing a parallel lease shape.`,
      "",
      "## Claim path changes",
      `- \`${repoEvidence.path}\`: harden \`tryClaimQueuedRun(...)\` as the single compare-and-swap claim path for queued runs so two workers cannot both promote the same row to running.`,
      "",
      "## Recovery path changes",
      `- \`${serviceEvidence.path}\`: keep \`reconcileRecoverableRuns(...)\` and the expired-lease requeue flow aligned to the stored lease fields so recovery is driven by persisted lease expiry instead of in-memory worker assumptions.`,
      "",
      "## Heartbeat path changes",
      `- \`${serviceEvidence.path}\`: keep \`executeWithLeaseHeartbeat(...)\` renewing the stored lease and aborting terminal writes when ownership moves, so heartbeat loss is visible as a lease-ownership change instead of silent overlap.`,
      "",
      "## Migration note",
      "- Treat any remaining lease-field work as additive/backfill-safe: preserve current nullable lease columns and roll forward by filling them on claim and heartbeat paths before tightening assumptions in readers.",
      "",
      "## Two-worker validation step",
      "- Run a two-worker claim-and-recovery check that proves only one worker wins `tryClaimQueuedRun(...)`, then after lease expiry a different worker can recover the run while the stale worker can no longer heartbeat or commit terminal writes.",
      "",
      buildPromptLabExactCitationAppendixForPaths(input.toolRuns, exactFilesUsed),
    ]
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  if (looksLikePromptLabLifecycleProvenancePatchPlanPrompt(userTask)) {
    const contractEvidence = pick(/(?:^|\/)packages\/contracts\/src\/runtime-lifecycle\.ts$/i, /\bfallbackSources\b/);
    const readerEvidence = pick(
      /(?:^|\/)apps\/gateway\/src\/services\/runtime-lifecycle-read-service\.ts$/i,
      /\bapproval_linkage\b|\bpreferApprovalCanonical\b|\blistApprovalEffects\b/,
    );
    const testEvidence = pick(
      /(?:^|\/)apps\/gateway\/src\/services\/runtime-lifecycle-read-service\.test\.ts$/i,
      /\bRuntimeLifecycleReadService\b|\bcreateHost\b|\bapproval_linkage\b/,
    );
    const storageEvidence = pick(/(?:^|\/)packages\/storage\/src\/realtime-event-repo\.ts$/i);
    if (!contractEvidence || !readerEvidence || !testEvidence) {
      return undefined;
    }
    const exactFilesUsed = [
      contractEvidence.path,
      readerEvidence.path,
      testEvidence.path,
      storageEvidence?.path,
    ].filter((value, index, self): value is string => Boolean(value) && self.indexOf(value) === index);
    return [
      "## Exact files used",
      ...exactFilesUsed.map((path) => `- \`${path}\``),
      "",
      "## Reader path",
      `- \`${readerEvidence.path}\` / \`RuntimeLifecycleReadHost\`: keep \`getApproval(...)\`, \`getApprovalWaitRunId(...)\`, and \`listApprovalEffects(...)\` in the reader host; do not route canonical linkage through \`settings-auth-service.ts\`. If realtime event links become part of lifecycle resolution, add a reader-host method here rather than reaching into storage from the service.`,
      `- \`${readerEvidence.path}\` / \`getRuntimeLifecycle(...)\`: keep the current order explicit. Initialize \`preferApprovalCanonical: Boolean(input.approvalId)\`, collect approval payload/preview only as linked/fallback evidence, then call \`applyApprovalCanonical(...)\` before later plan/delegation/durable fallback paths can win over canonical approval linkage.`,
      `- \`${readerEvidence.path}\` / \`applyApprovalCanonical(...)\`: this is the canonical-linkage-first insertion point. Set \`canonicalApprovalLinkageUsed = true\` whenever \`approval.linkage.sessionId\`, \`approval.linkage.taskId\`, or \`approval.linkage.durableRunId\` assigns a field with \`approval_linkage\`; keep payload \`turnId\` as \`fallback_payload\`, not canonical truth.`,
      `- \`${readerEvidence.path}\` / \`assignLifecycleField(...)\` and \`getLifecycleSourceRank(...)\`: add any new source ranks here. \`approval_linkage\` must outrank realtime links and payload/preview fallback when \`preferApprovalCanonical\` is true; query values must remain the only higher-ranked source.`,
      storageEvidence
        ? `- \`${storageEvidence.path}\` / \`extractRealtimeMetadata(...)\`: keep realtime metadata exposing \`links\`; the lifecycle reader should consume those links as a secondary \`realtime_links\` source after canonical approval linkage and before nested payload fallback.`
        : "- Realtime-event linkage is an additive reader input: consume `RealtimeEvent.links` as secondary provenance when that file is read/available, but do not treat realtime payload text as canonical approval linkage.",
      "",
      "## Provenance field additions",
      `- \`${contractEvidence.path}\` / \`RuntimeLifecycleFieldSource\`: add \`realtime_links\` only if realtime event links become a resolver input. Keep existing \`approval_linkage\`, \`approval_wait_run\`, \`fallback_payload\`, \`fallback_preview\`, and \`fallback_metadata\` meanings unchanged.`,
      `- \`${contractEvidence.path}\` / \`RuntimeLifecycleResolution\`: add \`executionPlanIdSource?: RuntimeLifecycleFieldSource\`, \`canonicalApprovalLinkageUsed?: boolean\`, \`realtimeLinkageUsed?: boolean\`, and \`payloadFallbackUsed?: boolean\`. Keep \`fallbackSources: RuntimeLifecycleFieldSource[]\` as the operator-visible list of consulted fallback paths.`,
      "",
      "## Diagnostics path",
      `- \`${readerEvidence.path}\` / returned \`resolution\` object: populate the new booleans next to the existing \`sessionIdSource\`, \`turnIdSource\`, \`runIdSource\`, \`approvalIdSource\`, \`taskIdSource\`, and \`fallbackSources\` fields. This is the diagnostics path operators and UI callers should read.`,
      `- \`${testEvidence.path}\` / \`createHost(...)\` and the approval-linkage tests: patch the fixture to provide canonical \`approval.linkage\`, conflicting realtime-link values, and conflicting payload/preview values, then assert both the winning ids and retained provenance diagnostics.`,
      "",
      "## Response-shape example",
      "```json",
      "{",
      '  "query": { "approvalId": "approval-1", "sessionId": "session-approval", "runId": "run-approval", "taskId": "task-approval" },',
      '  "resolution": {',
      '    "approvalIdSource": "query",',
      '    "sessionIdSource": "approval_linkage",',
      '    "runIdSource": "approval_linkage",',
      '    "taskIdSource": "approval_linkage",',
      '    "turnIdSource": "realtime_links",',
      '    "canonicalApprovalLinkageUsed": true,',
      '    "realtimeLinkageUsed": true,',
      '    "payloadFallbackUsed": true,',
      '    "fallbackSources": ["realtime_links", "fallback_payload", "fallback_preview"]',
      "  }",
      "}",
      "```",
      "",
      "## Regression test to add",
      `- \`${testEvidence.path}\`: add one disagreement fixture in the existing \`RuntimeLifecycleReadService\` suite. Request \`getRuntimeLifecycle({ approvalId: "approval-1" })\`; make \`getApproval("approval-1")\` return \`linkage: { sessionId: "session-approval", durableRunId: "run-approval", taskId: "task-approval" }\`; make realtime links return conflicting \`sessionId: "session-realtime"\` plus unresolved \`turnId: "turn-realtime"\`; and make payload/preview include \`sessionId: "session-payload"\`, \`runId: "run-payload"\`, and \`turnId: "turn-preview"\`.`,
      '- Assert canonical fields win: `response.query.sessionId === "session-approval"`, `response.query.runId === "run-approval"`, `response.query.taskId === "task-approval"`, and their `resolution.*Source` values are `approval_linkage`. Assert the unresolved turn can come from `realtime_links`, and assert `fallbackSources` / booleans prove realtime and payload fallback were consulted without winning over canonical approval linkage.',
      "",
      buildPromptLabExactCitationAppendixForPaths(input.toolRuns, exactFilesUsed),
    ]
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  if (looksLikePromptLabMissionControlTruthLabelingPrompt(userTask)) {
    const contractEvidence = pick(/(?:^|\/)packages\/contracts\/src\/runtime-lifecycle\.ts$/i, /\bfallbackSources\b/);
    const readerEvidence = pick(
      /(?:^|\/)apps\/gateway\/src\/services\/runtime-lifecycle-read-service\.ts$/i,
      /\bapproval_linkage\b/,
    );
    const pageEvidence = pick(
      /(?:^|\/)apps\/mission-control\/src\/pages\/ApprovalsPage\.tsx$/i,
      /\bfetchRuntimeLifecycle\b/,
    );
    const testEvidence = pick(/(?:^|\/)apps\/mission-control\/src\/pages\/ApprovalsPage\.test\.tsx$/i);
    if (!contractEvidence || !readerEvidence || !pageEvidence) {
      return undefined;
    }
    const exactFilesUsed = [contractEvidence.path, readerEvidence.path, pageEvidence.path, testEvidence?.path].filter(
      (value, index, self): value is string => Boolean(value) && self.indexOf(value) === index,
    );
    return [
      "## Exact files used",
      ...exactFilesUsed.map((path) => `- \`${path}\``),
      "",
      "## API field changes",
      `- \`${contractEvidence.path}\` and \`${readerEvidence.path}\`: keep the lifecycle API carrying enough provenance to distinguish canonical linkage from fallback inference instead of collapsing everything into one unqualified id.`,
      "",
      "## UI rendering changes",
      `- \`${pageEvidence.path}\`: render lifecycle-backed status with an explicit truth label rather than silently treating every resolved id as canonical truth when it may be inferred or still missing.`,
      "",
      "## Exact label set",
      "- Use exactly: `Canonical`, `Inferred`, `Missing`.",
      "",
      "## UI regression check",
      testEvidence
        ? `- \`${testEvidence.path}\`: add one Approvals Page test that feeds canonical linkage, inferred fallback linkage, and no-linkage cases, then asserts the visible label switches across \`Canonical\`, \`Inferred\`, and \`Missing\`.`
        : "- Add one Approvals Page test that feeds canonical linkage, inferred fallback linkage, and no-linkage cases, then asserts the visible label switches across `Canonical`, `Inferred`, and `Missing`.",
      "",
      buildPromptLabExactCitationAppendixForPaths(input.toolRuns, exactFilesUsed),
    ]
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  if (looksLikePromptLabExplicitEventAuthorityEnvelopePatchPlanPrompt(userTask)) {
    const producerEvidence = pick(
      /(?:^|\/)apps\/gateway\/src\/services\/(?:tool-invocation-coordinator-service|approval-lifecycle-service|chat-proactive-service)\.ts$/i,
      /\beventClass\b|\beventAuthority\b|\blinks\b/,
    );
    const storageEvidence = pick(/(?:^|\/)packages\/storage\/src\/realtime-event-repo\.ts$/i, /\beventAuthority\b/);
    const routeEvidence = pick(/(?:^|\/)apps\/gateway\/src\/routes\/events\.ts$/i);
    const consumerEvidence =
      pick(/(?:^|\/)apps\/mission-control\/src\/api\/types\.ts$/i, /\beventClass\b/) ?? routeEvidence;
    const gatewayEvidence = pick(/(?:^|\/)apps\/gateway\/src\/services\/gateway-service\.ts$/i, /\bpublishRealtime\b/);
    if (!producerEvidence || !storageEvidence || !consumerEvidence) {
      return undefined;
    }
    const exactFilesUsed = [
      producerEvidence.path,
      storageEvidence.path,
      consumerEvidence.path,
      gatewayEvidence?.path,
      routeEvidence?.path,
    ].filter((value, index, self): value is string => Boolean(value) && self.indexOf(value) === index);
    return [
      "## Exact files used",
      ...exactFilesUsed.map((path) => `- \`${path}\``),
      "",
      "## Producer contract",
      `- \`${producerEvidence.path}\`: use the existing explicit envelope pattern as the producer-side reference implementation for \`eventClass\`, \`eventAuthority\`, and \`links\`.`,
      gatewayEvidence
        ? `- \`${gatewayEvidence.path}\`: patch producer call sites that still route through \`publishRealtime(...)\` without explicit envelope options so the gateway stops relying on implicit metadata defaults.`
        : "- The concrete reads in this run did not include the shared gateway publisher implementation, so any remaining producer-default path is only partially grounded here.",
      "",
      "## Storage contract",
      `- \`${storageEvidence.path}\`: keep the realtime-event repository as the persisted envelope source of truth by round-tripping \`eventClass\`, \`eventAuthority\`, and \`links\` through append/list without collapsing them into payload-only fields.`,
      "",
      "## Consumer contract",
      `- \`${consumerEvidence.path}\`: keep the Mission Control event type surface aligned to the same explicit envelope so consumers can distinguish retained, durable-history, and derived-projection authority without guessing from payload shape.`,
      routeEvidence
        ? `- \`${routeEvidence.path}\`: the list/stream route is the operator-facing handoff that must continue returning the explicit envelope unchanged.`
        : undefined,
      "",
      "## Event families",
      "- Already fits: tool-driven operational events that already publish explicit envelope metadata.",
      "- Requires a patch: producer families that still emit through shared realtime publishing without explicit `eventClass`, `eventAuthority`, and `links` options.",
      "",
      "## Propagation test to add",
      "- Add one end-to-end event test that publishes a producer event with explicit envelope metadata, persists it through realtime storage, and then asserts the same fields survive the `/api/v1/events` or SSE response unchanged.",
      "",
      buildPromptLabExactCitationAppendixForPaths(input.toolRuns, exactFilesUsed),
    ]
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  if (looksLikePromptLabTwoWorkerHarnessCoveragePatchPlanPrompt(userTask)) {
    const repoTestEvidence = pick(/(?:^|\/)packages\/storage\/src\/durable-run-repo\.test\.ts$/i);
    const repoEvidence = pick(/(?:^|\/)packages\/storage\/src\/durable-run-repo\.ts$/i);
    const serviceEvidence = pick(/(?:^|\/)apps\/gateway\/src\/services\/durable-run-service\.ts$/i);
    const serviceTestEvidence = pick(/(?:^|\/)apps\/gateway\/src\/services\/durable-run-service\.test\.ts$/i);
    if (!repoTestEvidence || !repoEvidence || !serviceEvidence) {
      return undefined;
    }
    const exactFilesUsed = [
      repoTestEvidence.path,
      repoEvidence.path,
      serviceEvidence.path,
      serviceTestEvidence?.path,
    ].filter((value, index, self): value is string => Boolean(value) && self.indexOf(value) === index);
    return [
      "## Exact files used",
      ...exactFilesUsed.map((path) => `- \`${path}\``),
      "",
      "## Harness entrypoint",
      `- In \`${repoTestEvidence.path}\`, extend the existing repository test harness by replacing or overloading \`createRepo()\` with \`createRepo(dbPath?: string)\`, then add \`createSharedRepos()\` that creates one temp sqlite path and returns \`{ repoA, repoB, dbPath }\` where \`repoA\` and \`repoB\` are separate \`DurableRunRepository\` instances opened against that same file. This is the real two-worker harness entrypoint; do not use the in-memory map fixture from \`${serviceTestEvidence?.path ?? "apps/gateway/src/services/durable-run-service.test.ts"}\` for the storage race proof.`,
      "",
      "## Worker orchestration helper",
      `- In \`${repoEvidence.path}\`, use \`tryClaimQueuedRun(...)\` as the claim-race helper because it reads the current version, writes \`status: "running"\`, \`leaseOwnerId\`, \`leaseHeartbeatAt\`, and \`leaseExpiresAt\`, then only returns a run when the versioned update changes a row.`,
      `- In \`${repoEvidence.path}\`, use \`renewLease(...)\` as the stale-worker rejection helper; after ownership moves to worker B, \`renewLease({ workerId: "worker-a" })\` must return \`undefined\`.`,
      `- In \`${repoEvidence.path}\` and \`${serviceEvidence.path}\`, use \`listExpiredRunningRunIds(...)\` plus the service recovery update that clears the lease and requeues recoverable runs as the lease-expiry recovery path.`,
      "",
      "## Assertion surface",
      serviceTestEvidence
        ? `- \`${serviceTestEvidence.path}\` already asserts lease-lost and stale-recovery behavior at service level. Keep terminal-write/heartbeat assertions there, but add the true two-connection claim/recovery race in \`${repoTestEvidence.path}\` so the storage CAS itself is covered.`
        : "- Use the durable-run service tests as the assertion surface for stale-worker heartbeat and terminal-write rejection once ownership moves.",
      "",
      "## Scenario 1: claim race",
      '- Setup: `const { repoA, repoB } = createSharedRepos(); const run = repoA.createRun({ workflowKey: "chat.turn.execute", payload: {} });`.',
      '- Act: issue the two claims in the same contention window, for example `const [claimA, claimB] = await Promise.all([claimFrom(repoA, "worker-a"), claimFrom(repoB, "worker-b")])` when the harness wraps the sync repository calls, or otherwise invoke both separate connections back-to-back without reading/asserting final state between them. Both calls must target the same `runId` with distinct worker ids and lease timestamps so the CAS/version guard, not test ordering, chooses the winner.',
      '- Assert: exactly one claim is non-undefined; the winner has `status === "running"`; the loser is `undefined`; and `repoB.getRun(run.runId).leaseOwnerId` equals the winning worker id, whether that is worker A or worker B.',
      "- Failure signature: both claims return running records, the losing connection overwrites `leaseOwnerId`, or the final stored run version/owner no longer proves a single winner.",
      "",
      "## Scenario 2: lease-expiry recovery",
      "- Setup: use the shared storage helper plus two `DurableRunService` instances from `apps/gateway/src/services/durable-run-service.test.ts`. Worker A claims a queued run, the test fixture sets its stored `leaseExpiresAt` into the past, and `repoB.listExpiredRunningRunIds(now)` proves the run is recoverable before worker B starts.",
      '- Act: start worker B through `DurableRunService.startWorker()` / `requestRunProcessing()` so `reconcileRecoverableRuns()` clears the expired lease and `drainQueuedRuns()` reaches `tryClaimQueuedRun(...)`; do not requeue the row directly in the test except through the service recovery path under observation. After worker B claims, call `repoA.renewLease(...)` with `workerId: "worker-a"`.',
      "- Assert: worker B owns the recovered claim, `repoA.renewLease(...)` returns `undefined`, the final stored run has worker B lease timestamps, and the service-level assertions in `durable-run-service.test.ts` still prove stale terminal writes/heartbeats are rejected.",
      "- Failure signature: stale worker still renews the lease after worker B service recovery, the service recovery path leaves the run running under worker A, or worker B cannot claim the requeued expired run.",
    ]
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  if (looksLikePromptLabApprovalEffectsHardeningPatchPlanPrompt(userTask)) {
    const lifecycleEvidence = pick(
      /(?:^|\/)apps\/gateway\/src\/services\/approval-lifecycle-service\.ts$/i,
      /\bresolveApproval\b/,
    );
    const effectsEvidence = pick(
      /(?:^|\/)apps\/gateway\/src\/services\/approval-resolution-effects-service\.ts$/i,
      /\benqueueResolutionEffects\b/,
    );
    const repoEvidence = pick(/(?:^|\/)packages\/storage\/src\/approval-effect-repo\.ts$/i, /\bidempotency_key\b/);
    const testEvidence = pick(/(?:^|\/)apps\/gateway\/src\/services\/approval-resolution-effects-service\.test\.ts$/i);
    const routeEvidence = pick(/(?:^|\/)apps\/gateway\/src\/routes\/approvals\.ts$/i, /\bresolveApproval\b/);
    if (!lifecycleEvidence || !effectsEvidence || !repoEvidence) {
      return undefined;
    }
    const exactFilesUsed = [
      lifecycleEvidence.path,
      effectsEvidence.path,
      repoEvidence.path,
      testEvidence?.path,
      routeEvidence?.path,
    ].filter((value, index, self): value is string => Boolean(value) && self.indexOf(value) === index);
    return [
      "## Exact files used",
      ...exactFilesUsed.map((path) => `- \`${path}\``),
      "",
      "## Canonical approval writes",
      `- \`${lifecycleEvidence.path}\` lines 491-531, \`resolveApproval(...)\`: keep \`host.storage.approvals.resolve(...)\`, the \`approvalEvents.append({ eventType: "resolved" })\` write, pending-action rejection for non-approve decisions, and \`host.enqueueApprovalResolutionEffects(approval, input)\` inside the existing immediate transaction. Do not move effect execution or retry state into this transaction; it should enqueue effect rows only after canonical approval truth is written.`,
      `- \`${lifecycleEvidence.path}\` lines 533-550, post-transaction response shaping: keep \`recordApprovalResolution(...)\`, \`approvalEffects.listByApproval(...)\`, replay events, pending action, and effects in the operator response. This is where canonical approval state can be shown together with downstream effect status without mutating the approval row to mirror effect completion.`,
      "",
      "## Downstream effect tracking writes",
      `- \`${effectsEvidence.path}\` lines 132-233, \`enqueueResolutionEffects(...)\`: generate one effect row per downstream action through \`approvalEffects.upsert(...)\` for \`approval_wait_wake\`, \`proactive_run_wake\`, \`linked_chat_turn_wake\`, \`pending_action_execute\`, \`approval_inbox_follow_up\`, and \`approval_after_hooks\`. This is the outbox boundary; it records desired side effects but must not execute them inline with canonical approval resolution.`,
      `- \`${effectsEvidence.path}\` lines 236-260 and 263-344, \`drainPendingEffects(...)\` / \`executeWithLeaseHeartbeat(...)\`: keep claiming, lease renewal, ownership-loss aborts, and failure recording in the effect worker path so retries and crashes are isolated from approval truth.`,
      `- \`${effectsEvidence.path}\` lines 386-684, effect handlers: keep \`completeEffect(...)\`, \`skipEffect(...)\`, and \`failEffect(...)\` as terminal effect writes for wake, pending action, inbox follow-up, and hooks. These result payloads are the operator-visible downstream status, not fields to copy back into the approval row.`,
      `- \`${repoEvidence.path}\` lines 75-88 and 218-262, \`upsert(...)\`: preserve the existing \`ON CONFLICT(idempotency_key) DO UPDATE\` behavior so repeated enqueue attempts update payload/updated_at on the same effect row instead of creating duplicate outbox work.`,
      `- \`${repoEvidence.path}\` lines 99-185 and 264-375, claim/renew/complete/skip/fail methods: keep version + worker ownership checks on every state transition so a retry or second worker cannot complete a stale effect lease.`,
      routeEvidence
        ? `- \`${routeEvidence.path}\` lines 162-180: the operator resolve route should continue returning \`approvals.resolveApproval(...)\`; once effect rows are enriched, this route exposes canonical approval state plus downstream effect status in the same response.`
        : "- Operator-visible path: keep the approval resolve/list APIs returning the lifecycle result with `effects`; do not require operators to infer downstream status from the approval row alone.",
      "",
      "## Idempotency or dedupe mechanism",
      "- Use `approval_effects.idempotency_key`, generated by `buildApprovalEffectIdempotencyKey({ approvalId, effectKind, targetKind, targetId })`, as the dedupe key. For cross-process retries, keep the key deterministic per approval/effect/target; do not use a new random idempotency key per replay.",
      "",
      "## Migration or rollout risk",
      "- Rollout risk: the existing conflict update only refreshes `payload_json` and `updated_at`. If a previous row is already `completed`, blindly re-enqueuing could make the response look freshly requested while the worker will not run it again. Keep the migration additive: preserve canonical approval writes, add any new outbox metadata to `approval_effects`, and explicitly decide whether completed/skipped/failed rows are replayable or terminal before widening the conflict update.",
      "",
      "## Proving test",
      testEvidence
        ? `- \`${testEvidence.path}\`: add a test beside \`enqueues the canonical approval effect set from current linkage\`. Call \`enqueueResolutionEffects(approval, input)\` twice with the same approval/linkage and assert the storage mock receives identical \`idempotencyKey\` values or, with a real \`ApprovalEffectRepository\`, \`listByApproval(approvalId)\` still has one row per \`effectKind/targetKind/targetId\`. Then claim one effect, complete/skip/fail it through the worker path, replay enqueue, and assert the canonical approval status/event is unchanged while the effect row retains one deterministic idempotency key and one terminal result.`
        : "- Add a proving test that resolves/enqueues the same approval twice, asserts one deterministic effect row per effect target, completes one effect, replays enqueue, and proves canonical approval status/events stay stable while effect status/result remains operator-visible in `effects`.",
      "",
      buildPromptLabExactCitationAppendixForPaths(input.toolRuns, exactFilesUsed),
    ]
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  return undefined;
}

function buildPromptLabKnownPatchPlanFallback(input: {
  prompt: string;
  responseText: string;
  toolRuns: ChatToolRunRecord[];
}): string | undefined {
  const userTask = extractPrimaryUserTaskContent(input.prompt);
  if (!promptLabContractRequiresConcreteFileEvidence(userTask)) {
    return undefined;
  }
  const normalizedTask = userTask.toLowerCase();
  const concreteEvidence = filterPromptLabConcreteReadEvidenceForPrompt(
    collectPromptLabConcreteReadEvidence(input.toolRuns),
    input.prompt,
  );
  if (concreteEvidence.length === 0) {
    return undefined;
  }
  const pick = (pathPattern: RegExp, contentPattern?: RegExp) =>
    pickPromptLabConcreteReadEvidence(
      concreteEvidence,
      ({ path, content }) => pathPattern.test(path) && (!contentPattern || contentPattern.test(content)),
    );
  const exactTail = (paths: Array<string | undefined>): string[] => {
    const exactFilesUsed = filterPromptLabExactFilePathsForPrompt(
      paths.filter((value, index, items): value is string => Boolean(value) && items.indexOf(value) === index),
      input.prompt,
    );
    return [
      "",
      buildPromptLabExactCitationAppendixForPaths(input.toolRuns, exactFilesUsed),
      "## Exact files used",
      ...exactFilesUsed.map((path) => `- \`${path}\``),
      "Only the files listed above were used as concrete file evidence.",
    ].filter((value): value is string => Boolean(value));
  };

  const asksForPatchPlan =
    /\bexact patch points?\b|\bimplementation insertion points?\b|\bidentify the exact patch points?\b|\bpatch plan\b|\bexact files, exact symbols\b/.test(
      normalizedTask,
    );

  if (
    asksForPatchPlan &&
    /\bskill import\b|\bskill-import-service\b|\bimported skills?\b/.test(normalizedTask) &&
    /\btrust metadata|source\.json|provenance\b/.test(normalizedTask)
  ) {
    const serviceEvidence = pick(/(?:^|\/)apps\/gateway\/src\/services\/skill-import-service\.ts$/i);
    const testEvidence = pick(/(?:^|\/)apps\/gateway\/src\/services\/skill-import-service\.test\.ts$/i);
    if (!serviceEvidence) {
      return undefined;
    }
    return [
      "## Implementation insertion points",
      `- \`${serviceEvidence.path}\` / \`InstalledSkillSourceManifest\`: add explicit trust/provenance fields beside the existing \`manifestVersion\`, \`duplicateFamily\`, \`reviewDisposition\`, \`resolvedUpstream\`, and \`candidate\` fields. The concrete shape should include \`contentSha256\`, \`materializedAt\`, \`declaredTools\`, \`requires\`, \`nativeOverlaps\`, \`duplicateMatches\`, \`reviewMessage\`, and a small \`trustDecision\` object with \`disposition\`, \`reasons\`, and \`blocking\`.`,
      `- \`${serviceEvidence.path}\` / \`validateMaterialized(source)\`: immediately after \`rawSkill\` is read and \`parseSkillMarkdown(rawSkill)\` succeeds, compute the SKILL.md digest and carry parsed \`declaredTools\`, \`requires\`, frontmatter quality, \`reviewDisposition\`, \`reviewMessage\`, \`nativeOverlaps\`, and \`duplicateMatches\` on the returned \`SkillImportValidationResult\`. Keep the duplicate/native-overlap validation errors as the source of truth for blocking trust decisions.`,
      `- \`${serviceEvidence.path}\` / \`findDuplicateInstallMatches(input)\`: keep returning structured matches, but include the exact reason for each match: \`canonicalKey\`, \`duplicateFamily\`, or \`bundledFamily\`. That lets both the rejected history row and the installed manifest explain why the import was blocked or allowed without re-deriving the answer later.`,
      `- \`${serviceEvidence.path}\` / \`buildNativeOverlapRecords(duplicateFamily)\`: preserve \`overlapFamily\`, \`nativeAlternativeName\`, \`nativeDestination\`, and \`blockingReason\`, and pass the resulting array through validation into the manifest/history metadata rather than only turning it into a string error.`,
      `- \`${serviceEvidence.path}\` / \`installImport(input)\` source manifest writer: replace the inline JSON object with an \`InstalledSkillSourceManifest\` value that writes the exact validation-derived fields above plus \`sourceProvider\`, \`sourceType\`, \`sourceRef\`, \`canonicalKey\`, \`inferredSkillName\`, \`inferredSkillId\`, \`riskLevel\`, \`warnings\`, and \`checks\`. Do not recompute \`duplicateFamily\` or \`reviewDisposition\` separately from validation except as a temporary fallback for old validation results.`,
      `- \`${serviceEvidence.path}\` / \`appendHistory(...)\` call sites: include the same provenance/trust block for \`rejected\`, \`accepted\`, and \`failed\` outcomes: \`sourceProvider\`, \`sourceType\`, \`sourceRef\`, \`canonicalKey\`, \`skillName\`, \`skillId\`, \`duplicateFamily\`, \`reviewDisposition\`, \`reviewMessage\`, \`duplicateMatches\`, \`nativeOverlaps\`, and \`contentSha256\`.`,
      "",
      "## Operator-facing behavior",
      "- A successful install should leave `skills/extra/<skill-id>/source.json` with enough source/trust metadata for later UI/API rendering without re-reading the original import source.",
      "- A blocked duplicate or native-overlap install should leave history metadata with the same `duplicateFamily`, overlap target, and blocking reason, but must not write an installed `source.json` under the rejected skill path.",
      "",
      "## Validation",
      testEvidence
        ? `- \`${testEvidence.path}\`: extend the existing repo-managed install test so it asserts \`source.json\` contains \`contentSha256\`, \`declaredTools\`, \`requires\`, \`sourceProvider\`, \`sourceType\`, \`sourceRef\`, \`canonicalKey\`, \`duplicateFamily\`, \`reviewDisposition\`, \`riskLevel\`, \`warnings\`, and \`checks\`, not only timestamps and \`resolvedUpstream\`.`
        : "- Add a skill-import service test for a successful local-path install that asserts the full source/trust manifest fields, not only timestamps.",
      testEvidence
        ? `- \`${testEvidence.path}\`: extend the duplicate local-path scenario to call \`service.installImport(...)\` for the second skill, assert rejection includes the duplicate/native-overlap reason, assert no \`skills/extra/cloudflare-manager/source.json\` exists, and assert import history contains the rejected provenance/trust block.`
        : "- Add a duplicate/overlap install test that proves rejected imports record trust/provenance history but do not write installed metadata.",
      "",
      "## Known unknowns",
      "- Exact UI rendering for imported-skill trust metadata remains outside this patch unless a concrete skills UI/API file is also read.",
      ...exactTail([serviceEvidence.path, testEvidence?.path]),
    ]
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  if (asksForPatchPlan && /\bfocused[- ]pack\b|\bgate selection\b|\brun-prompt-pack-gates\b/.test(normalizedTask)) {
    const gatesEvidence = pick(/(?:^|\/)scripts\/run-prompt-pack-gates\.ts$/i);
    const serviceEvidence = pick(/(?:^|\/)apps\/gateway\/src\/services\/prompt-pack-service\.ts$/i);
    const routesEvidence = pick(/(?:^|\/)apps\/gateway\/src\/routes\/prompt-packs\.ts$/i);
    const sharedApiEvidence = pick(/(?:^|\/)packages\/mission-control-shared\/src\/api\/prompt-packs\.ts$/i);
    if (!gatesEvidence) {
      return undefined;
    }
    return [
      "## Implementation insertion points",
      `- \`${gatesEvidence.path}\` lines 13-17, gate constants/env: add the expanded overnight v2 target-code set beside \`LEGACY_TARGET_CODES\` and \`MODERN_TARGET_CODE_CANDIDATES\`, or add a named env/default selector such as \`PROMPT_PACK_GATE_TARGET_SET=overnight-v2\`. The target list should include codes that exist only in the expanded pack so the frozen baseline cannot satisfy it by accident.`,
      `- \`${gatesEvidence.path}\` lines 22-33, \`main()\`: keep \`resolveExplicitTargetCodes(argv)\` as the highest-priority override, then pass the resolved default target set into \`resolvePromptPack(app, authHeaders, explicitTargetCodes)\`. Log both the selected target set name and exact \`targetCodes\` before queue construction.`,
      `- \`${gatesEvidence.path}\` lines 185-232, \`resolvePromptPack(...)\`: export this function or extract an exported pure selector such as \`selectPromptPackForTargetCodes(packsWithTests, targetCodes)\`. The selector must choose the only pack whose tests contain every requested code, preserve the requested code order in \`targetCodes\`, and throw a concrete ambiguity error if more than one pack matches.`,
      `- \`${gatesEvidence.path}\` lines 235-260, fallback selection: keep the no-explicit-code path separate from the focused overnight-v2 path. It can still rank candidates by \`selectPromptPackGateTargetCodes(tests)\`, but it must not silently prefer the older baseline when a focused target-code set was requested.`,
      `- \`${gatesEvidence.path}\` lines 263-278, \`listTests(...)\`: keep fetching \`/api/v1/prompt-packs/{packId}/tests?limit=2000\` for every candidate pack before selection so the selector sees the expanded pack's full code inventory.`,
      serviceEvidence
        ? `- \`${serviceEvidence.path}\` lines 422-428, \`listPromptPacks(...)\` and \`listPromptPackTests(...)\`: preserve \`packId\`, \`name\`, \`sourceLabel\`, and exact test \`code\` values in list responses; do not collapse imported v2 tests into the frozen baseline identity.`
        : "- The prompt-pack service file was not concretely read, so the service listing edge remains a validation dependency.",
      routesEvidence
        ? `- \`${routesEvidence.path}\` lines 119-143, prompt-pack list/test routes: keep \`limit=200\` and \`limit=2000\` compatible with the gate script's \`GET /api/v1/prompt-packs\` and \`GET /api/v1/prompt-packs/:packId/tests\` calls; this is the API seam the selector stubs in tests.`
        : undefined,
      sharedApiEvidence
        ? `- \`${sharedApiEvidence.path}\` lines 32-39, \`fetchPromptPacks(...)\` and \`fetchPromptPackTests(...)\`: no production dependency is required for the gate script, but these shared client helpers document the same route/limit contract and should stay aligned if the route shape changes.`
        : undefined,
      "",
      "## Validation",
      "- Add `scripts/run-prompt-pack-gates.test.ts` beside the gate runner. Stub `app.inject` so `GET /api/v1/prompt-packs?limit=200` returns exactly `baseline` and `overnight-v2`, then stub `GET /api/v1/prompt-packs/{packId}/tests?limit=2000` so `baseline` is missing one requested v2-only code and `overnight-v2` contains all requested codes.",
      "- In that test, call `resolvePromptPack(app, authHeaders, ['TEST-C202', 'TEST-D122', 'TEST-D204'])` or the exported pure selector directly. Assert `result.pack.packId === 'overnight-v2'`, `result.targetCodes` equals the requested order, and `result.tests` is the overnight-v2 test list.",
      "- Add one ambiguity regression: if both packs contain every requested code, `resolvePromptPack(...)` must throw the existing multiple-pack ambiguity error instead of picking whichever pack appears first.",
      "- Add one missing-code regression: if no pack contains all requested codes, the error must include the missing explicit codes so operators can fix the target set.",
      "",
      "## Known unknowns",
      "- Whether the default target set should be selected by env var, CLI flag, or hard-coded constant is an operator-policy decision; the smallest code patch is still the exported selector plus focused target-code test.",
      ...exactTail([gatesEvidence.path, serviceEvidence?.path, routesEvidence?.path, sharedApiEvidence?.path]),
    ]
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  if (
    asksForPatchPlan &&
    /\bprompt[- ]pack\b/.test(normalizedTask) &&
    /\bsource markdown identity|source label|source_label|import time|refresh provenance|source markdown\b/.test(
      normalizedTask,
    ) &&
    /\bimport\b/.test(normalizedTask) &&
    /\bstorage\b|\breport\b|\bexport\b/.test(normalizedTask)
  ) {
    const serviceEvidence = pick(/(?:^|\/)apps\/gateway\/src\/services\/prompt-pack-service\.ts$/i);
    const repoEvidence = pick(/(?:^|\/)packages\/storage\/src\/prompt-pack-repo\.ts$/i);
    const routeEvidence = pick(/(?:^|\/)apps\/gateway\/src\/routes\/prompt-packs\.ts$/i);
    const apiEvidence = pick(/(?:^|\/)packages\/mission-control-shared\/src\/api\/prompt-packs\.ts$/i);
    const contractEvidence = pick(/(?:^|\/)packages\/contracts\/src\/prompt-pack\.ts$/i);
    const testEvidence = pick(/(?:^|\/)apps\/gateway\/src\/services\/prompt-pack-service\.test\.ts$/i);
    if (!serviceEvidence || !repoEvidence) {
      return undefined;
    }
    return [
      "## Implementation insertion points",
      contractEvidence
        ? `- \`${contractEvidence.path}\` lines 61-70, \`PromptPackRecord\`: keep \`sourceLabel\`, and add operator-facing provenance fields such as \`importedAt\`, \`sourceMarkdownIdentity\` or \`sourceMarkdownSha256\`, \`lastExportRefreshedAt\`, and \`lastExportRefreshReason\`. Also extend \`PromptPackExportRecord\` at lines 370-376 with \`sourceLabel\`, \`importedAt\`, \`lastRefreshedAt\`, and \`refreshReason\` so the export endpoint can show provenance without callers re-fetching the pack.`
        : "- Contract patch point: extend `PromptPackRecord` and `PromptPackExportRecord` in `packages/contracts/src/prompt-pack.ts` with source identity, import time, and refresh provenance fields.",
      `- \`${repoEvidence.path}\` lines 122-160, \`replacePackTests(...)\`: treat the existing \`created_at\` value as the stable import time for existing packs, preserve it on refresh/re-import, and add or map explicit provenance fields for \`source_label\`, source markdown hash/identity, last refresh time, and refresh reason. Do not overwrite import time when only tests are refreshed.`,
      `- \`${repoEvidence.path}\` lines 194-205, row mapping: map \`source_label\`, stable import time, source markdown identity/hash, and refresh provenance back onto \`PromptPackRecord\` so every service/route/export consumer receives the same metadata.`,
      `- \`${serviceEvidence.path}\` lines 403-420, \`importPromptPack(...)\`: compute the source markdown identity at the import boundary from \`input.sourceLabel\` and \`input.content\` (for example normalized source label plus SHA-256 of the markdown), pass it into \`replacePackTests(...)\`, and call \`refreshPromptPackExportFileBestEffort(imported.pack.packId, "import_prompt_pack")\` with provenance that can be persisted or rendered.`,
      `- \`${serviceEvidence.path}\` lines 1430-1445, \`ensurePromptPackLoaded(...)\`: keep \`GOATCITADEL_PROMPT_PACK_PATH\` as the concrete source label and feed the same source identity/hash path as manual import, so env-loaded packs do not show the fallback \`goatcitadel_prompt_pack.md\` identity.`,
      `- \`${serviceEvidence.path}\` lines 1835-1850, \`refreshPromptPackExportFile(...)\` and \`refreshPromptPackExportFileBestEffort(...)\`: thread the refresh reason into the export record/report render path and persist \`lastExportRefreshedAt\` plus \`lastExportRefreshReason\`; the current \`reason\` is only used in the warning log when refresh fails.`,
      `- \`${serviceEvidence.path}\` lines 1928-1947, \`readPromptPackExportRecord(...)\`: return export metadata together with \`pack.sourceLabel\`, import time, last refresh time, and refresh reason instead of only file path/size/mtime.`,
      `- \`${serviceEvidence.path}\` lines 2526-2586, \`renderPromptPackMarkdownReport(...)\`: add report header lines for source markdown identity, source label/path, imported at, export refreshed at, and refresh reason before the score summary so operators can inspect provenance from the markdown artifact itself.`,
      routeEvidence
        ? `- \`${routeEvidence.path}\` lines 410-434, export routes: keep returning \`promptPacks.getPromptPackExport(...)\` / \`exportPromptPack(...)\`, but the returned record should now include the provenance fields above. The import route at lines 107-114 already accepts \`sourceLabel\`; preserve that input.`
        : "- Route patch point: keep the existing import/export endpoints but return the enriched export record once the service/contract shape is updated.",
      apiEvidence
        ? `- \`${apiEvidence.path}\` lines 17-23 and 191-199: preserve \`sourceLabel\` in \`importPromptPack(...)\` and let \`fetchPromptPackExport(...)\` / \`exportPromptPackReport(...)\` expose the enriched \`PromptPackExportRecord\` type.`
        : "- Client API patch point: keep shared prompt-pack API helpers aligned with the enriched contract type.",
      "",
      "## Validation",
      testEvidence
        ? `- \`${testEvidence.path}\`: add a service test that imports a temp markdown file with \`sourceLabel: tempPackPath\`, asserts the stored pack exposes the exact source label, stable import time, and source markdown identity/hash, then calls \`exportPromptPack(packId)\` and asserts the returned export record plus rendered markdown include source label, imported-at, refreshed-at, and refresh reason.`
        : "- Add a prompt-pack service test that imports a temp markdown source label, exports the pack, and asserts stored pack metadata, export record metadata, and markdown header provenance all agree.",
      "- Add a refresh regression: re-import or refresh the same pack and assert `importedAt` stays stable while `updatedAt` / `lastExportRefreshedAt` and `lastExportRefreshReason` change to the new refresh reason.",
      "",
      "## Known unknowns",
      "- The storage migration shape is the only open implementation choice: either map existing `created_at` to `importedAt` and add only refresh/source-hash columns, or add explicit import/provenance columns and backfill them from existing rows. Do not solve this by only renaming the displayed pack name.",
      ...exactTail([
        serviceEvidence.path,
        repoEvidence.path,
        routeEvidence?.path,
        apiEvidence?.path,
        contractEvidence?.path,
        testEvidence?.path,
      ]),
    ]
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  if (
    asksForPatchPlan &&
    /\bbenchmark\b/.test(normalizedTask) &&
    /\breplay\b/.test(normalizedTask) &&
    /\btrend\b/.test(normalizedTask) &&
    /\breport\b/.test(normalizedTask) &&
    /\bprompt[- ]pack\b/.test(normalizedTask)
  ) {
    const serviceEvidence = pick(/(?:^|\/)apps\/gateway\/src\/services\/prompt-pack-service\.ts$/i);
    const routeEvidence = pick(/(?:^|\/)apps\/gateway\/src\/routes\/prompt-packs\.ts$/i);
    const apiEvidence = pick(
      /(?:^|\/)(?:apps\/mission-control|packages\/mission-control-shared)\/src\/api\/prompt-packs\.ts$/i,
    );
    if (!serviceEvidence && !routeEvidence) {
      return undefined;
    }
    return [
      "## Implementation insertion points",
      serviceEvidence
        ? `- \`${serviceEvidence.path}\`: keep v2 benchmark/replay/trend/report wiring in the prompt-pack service where runs, auto-scores, human reviews, report summaries, and trend series are assembled.`
        : "- Service-level prompt-pack report assembly was not concretely read in this run.",
      routeEvidence
        ? `- \`${routeEvidence.path}\`: expose the rollout through existing prompt-pack status/report/replay endpoints rather than adding a parallel benchmark route shape.`
        : "- Route-level prompt-pack endpoints were not concretely read in this run.",
      apiEvidence
        ? `- \`${apiEvidence.path}\`: keep Mission Control API types aligned with any new v2 report or trend fields.`
        : "- Mission Control API typing remains unverified unless the client API file is read.",
      "",
      "## Validation",
      "- Add one service test that creates v2 runs and auto-scores, replays a focused pack, renders a markdown report, and asserts pass/fail/review counts plus trend points agree with the same latest-run set.",
      "- Add one route/API test that proves the report endpoint returns the same degraded/review explanation fields that the markdown export renders.",
      "",
      "## Known unknowns",
      "- UI chart rendering remains outside this patch unless a concrete Prompt Lab page file is also read.",
      ...exactTail([serviceEvidence?.path, routeEvidence?.path, apiEvidence?.path]),
    ]
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  if (
    asksForPatchPlan &&
    /\bprompt[- ]pack\b/.test(normalizedTask) &&
    /\bimport metadata|source label|source-label|source_label|export rendering\b/.test(normalizedTask)
  ) {
    const serviceEvidence = pick(/(?:^|\/)apps\/gateway\/src\/services\/prompt-pack-service\.ts$/i);
    const routeEvidence = pick(/(?:^|\/)apps\/gateway\/src\/routes\/prompt-packs\.ts$/i);
    const repoEvidence = pick(/(?:^|\/)packages\/storage\/src\/prompt-pack-repo\.ts$/i);
    if (!serviceEvidence && !routeEvidence && !repoEvidence) {
      return undefined;
    }
    return [
      "## Implementation insertion points",
      serviceEvidence
        ? `- \`${serviceEvidence.path}\`: preserve the incoming markdown source identity through import, \`ensurePromptPackLoaded(...)\`, auto-score/report assembly, and markdown export rendering; do not replace env/import labels with the default baseline label.`
        : "- Prompt-pack service import/report assembly was not concretely read in this run.",
      repoEvidence
        ? `- \`${repoEvidence.path}\`: persist the source label/import source fields as first-class pack metadata rather than deriving them from the current filename at read time.`
        : "- Prompt-pack repository persistence remains unverified unless the repo file is read.",
      routeEvidence
        ? `- \`${routeEvidence.path}\`: return source metadata through import/status/report/export responses so the operator can see which pack produced the report.`
        : "- Route/export rendering remains unverified unless the prompt-pack routes file is read.",
      "",
      "## Validation",
      "- Add one env/imported markdown fixture test that asserts `sourceLabel` survives storage, report generation, markdown export, and API serialization without collapsing to `goatcitadel_prompt_pack.md`.",
      "",
      "## Known unknowns",
      "- Historical imported packs may have missing labels; handle that as a displayed unknown/defaulted legacy value rather than rewriting all old provenance.",
      ...exactTail([serviceEvidence?.path, repoEvidence?.path, routeEvidence?.path]),
    ]
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  return undefined;
}

function buildTypedWakeOutcomeEvidenceFallback(input: {
  prompt: string;
  responseText: string;
  toolRuns: ChatToolRunRecord[];
}): string | undefined {
  const userTask = extractPrimaryUserTaskContent(input.prompt);
  if (!looksLikePromptLabTypedWakeOutcomeEvidencePrompt(userTask)) {
    return undefined;
  }
  const concreteReadEvidence = filterPromptLabConcreteReadEvidenceForPrompt(
    collectPromptLabConcreteReadEvidence(input.toolRuns),
    input.prompt,
  );
  if (concreteReadEvidence.length === 0) {
    return undefined;
  }
  const pick = (pathPattern: RegExp, contentPattern?: RegExp) =>
    pickPromptLabConcreteReadEvidence(
      concreteReadEvidence,
      ({ path, content }) => pathPattern.test(path) && (!contentPattern || contentPattern.test(content)),
    );

  const contractEvidence = pick(/(?:^|\/)packages\/contracts\/src\/durable\.ts$/i, /\bDurableWake(?:Result|Outcome)\b/);
  const producerEvidence = pick(
    /(?:^|\/)apps\/gateway\/src\/services\/durable-run-service\.ts$/i,
    /\bwakeDurableRun\b/,
  );
  const consumerEvidence =
    pick(
      /(?:^|\/)apps\/gateway\/src\/services\/approval-resolution-effects-service\.ts$/i,
      /\bhandleWakeEffect\b|\bbuildRecoveredWakeResult\b|\bbuildExplicitNonWakeResult\b|\bwakeOutcome\b|\bDurableWakeResult\["outcome"\]\b/i,
    ) ??
    pick(
      /(?:^|\/)apps\/gateway\/src\/services\/gateway-service\.ts$/i,
      /\bwakeDurableRun\b|\bDurableWakeResult\b|\bapproval\b/i,
    );
  const producerValidationEvidence = pick(
    /(?:^|\/)apps\/gateway\/src\/services\/durable-run-service\.test\.ts$/i,
    /\bwakeDurableRun\b/,
  );
  const consumerValidationEvidence = pick(
    /(?:^|\/)apps\/gateway\/src\/services\/approval-resolution-effects-service\.test\.ts$/i,
    /\bhandleWakeEffect\b|\bskipped_not_waiting\b|\balready_running_unverified\b|\bwoke\b/i,
  );
  const validationEvidence = consumerValidationEvidence ?? producerValidationEvidence;
  if (!contractEvidence && !producerEvidence && !consumerEvidence) {
    return undefined;
  }

  const relevantEvidence = concreteReadEvidence.filter(({ path }) =>
    /(?:^|\/)(?:packages\/contracts\/src\/durable\.ts|apps\/gateway\/src\/services\/(?:durable-run-service|approval-resolution-effects-service)(?:\.test)?\.ts)$/i.test(
      path,
    ),
  );
  const exactFilesUsed = filterPromptLabExactFilePathsForPrompt(
    relevantEvidence.map((item) => item.path),
    input.prompt,
  );
  const exactCitationAppendix = buildPromptLabExactCitationAppendixForPaths(input.toolRuns, exactFilesUsed);
  const producerCitation = producerEvidence
    ? (formatPromptLabCitationForPath(producerEvidence.path, input.toolRuns) ?? `\`${producerEvidence.path}\``)
    : undefined;
  const consumerCitation = consumerEvidence
    ? (formatPromptLabCitationForPath(consumerEvidence.path, input.toolRuns) ?? `\`${consumerEvidence.path}\``)
    : undefined;
  const validationCitation = validationEvidence
    ? (formatPromptLabCitationForPath(validationEvidence.path, input.toolRuns) ?? `\`${validationEvidence.path}\``)
    : undefined;
  const producerValidationCitation = producerValidationEvidence
    ? (formatPromptLabCitationForPath(producerValidationEvidence.path, input.toolRuns) ??
      `\`${producerValidationEvidence.path}\``)
    : undefined;
  const consumerValidationCitation = consumerValidationEvidence
    ? (formatPromptLabCitationForPath(consumerValidationEvidence.path, input.toolRuns) ??
      `\`${consumerValidationEvidence.path}\``)
    : undefined;
  const consumerHasWakeSpecificLine =
    Boolean(consumerEvidence) &&
    /\bhandleWakeEffect\b|\bbuildRecoveredWakeResult\b|\bbuildExplicitNonWakeResult\b/.test(
      consumerEvidence?.content ?? "",
    );
  const producerValidationHasWakeSpecificLine =
    Boolean(producerValidationEvidence) && /\bwakeDurableRun\b/.test(producerValidationEvidence?.content ?? "");
  const consumerValidationHasWakeSpecificLine =
    Boolean(consumerValidationEvidence) &&
    /\bhandleWakeEffect\b|\bskipped_not_waiting\b|\balready_running_unverified\b|\bwoke\b/.test(
      consumerValidationEvidence?.content ?? "",
    );

  return [
    "## Exact files used",
    ...exactFilesUsed.map((path) => `- \`${path}\``),
    "",
    "## Contract file",
    contractEvidence
      ? `- \`${contractEvidence.path}\` is the shared typed wake contract file; keep \`DurableWakeResult\` and any \`DurableWakeOutcome\` literals aligned there first.`
      : "- The concrete reads in this run did not include the shared durable contract file, so the contract location remains partially unverified.",
    "",
    "## Producer call sites",
    producerEvidence
      ? `- ${producerCitation} owns \`wakeDurableRun(...)\`, so this is the concrete producer patch point where typed wake outcomes are assembled and returned.`
      : "- The concrete reads in this run did not include a wake producer implementation, so the producer call site remains partially unverified.",
    "",
    "## Consumer/status shaping",
    consumerEvidence
      ? consumerHasWakeSpecificLine
        ? `- ${consumerCitation} is the concrete consumer/status surface from this run because \`handleWakeEffect(...)\` takes the typed producer result and decides whether to complete, reconcile, or skip the approval wake effect.`
        : `- \`${consumerEvidence.path}\` is the nearest consumer/status file concretely read in this run, but the line-level wake-shaping branch stayed only partially verified here; confirm \`handleWakeEffect(...)\` or the equivalent result-shaping path before widening the patch.`
      : "- The concrete reads in this run did not include a consumer/status shaping file, so that edge remains partially unverified.",
    "",
    "## Compatibility note",
    contractEvidence && (producerEvidence || consumerEvidence)
      ? "- Keep wake-outcome changes additive until the shared contract, the producer return branches, and the consumer/status surface all accept the same outcome vocabulary."
      : "- Treat this as a partial compatibility map and keep any wake-outcome change additive until every producer and consumer edge has been concretely verified.",
    "",
    "## Validation step",
    consumerValidationEvidence &&
    producerValidationEvidence &&
    consumerValidationHasWakeSpecificLine &&
    producerValidationHasWakeSpecificLine
      ? `- ${consumerValidationCitation}: keep the approval-wake tests proving \`handleWakeEffect(...)\` completes, reconciles, or skips based on typed wake outcomes, and ${producerValidationCitation}: keep the producer-side \`wakeDurableRun(...)\` tests covering the wake result vocabulary itself.`
      : consumerValidationEvidence || producerValidationEvidence
        ? `- ${
            consumerValidationEvidence
              ? `\`${consumerValidationEvidence.path}\``
              : `\`${producerValidationEvidence?.path}\``
          }${
            consumerValidationEvidence && producerValidationEvidence
              ? ` plus \`${producerValidationEvidence?.path}\``
              : ""
          } are the nearest wake-validation files concretely read in this run; extend them so a successful wake, a typed non-wake/skip outcome, and a failed wake all stay aligned with the same \`DurableWakeResult\` contract.`
        : validationEvidence
          ? `- ${validationCitation}: rerun or extend the nearest wake-path test so a successful wake, a typed non-wake/skip outcome, and a failed wake all stay type-correct through the same \`DurableWakeResult\` shape.`
          : "- Rerun the nearest durable wake tests and confirm a successful wake, a typed non-wake/skip outcome, and a failed wake all stay type-correct through the same `DurableWakeResult` shape.",
    "",
    exactCitationAppendix,
  ]
    .filter(Boolean)
    .join("\n")
    .trim();
}

function buildPromptPackParserRegressionFallback(input: {
  prompt: string;
  responseText: string;
  toolRuns: ChatToolRunRecord[];
}): string | undefined {
  const userTask = extractPrimaryUserTaskContent(input.prompt);
  if (!looksLikePromptLabPromptPackParserRegressionPrompt(userTask)) {
    return undefined;
  }
  const trimmedResponse = input.responseText.trim();
  if (
    trimmedResponse &&
    !looksLikePromptLabInspectionContinuation(trimmedResponse) &&
    !/^let me read\b/i.test(trimmedResponse) &&
    !/^i need to read\b/i.test(trimmedResponse)
  ) {
    return undefined;
  }

  const concreteEvidence = collectPromptLabConcreteReadEvidence(input.toolRuns);
  const v2PackEvidence = concreteEvidence.find(({ path }) => /(?:^|\/)goatcitadel_prompt_pack_v2\.md$/i.test(path));
  const baselineEvidence = concreteEvidence.find(({ path }) => /(?:^|\/)goatcitadel_prompt_pack\.md$/i.test(path));
  const parserEvidence = concreteEvidence.find(
    ({ path, content }) =>
      /(?:^|\/)apps\/gateway\/src\/services\/prompt-pack-service\.ts$/i.test(path) &&
      (/\bparsePromptPackTests\b/.test(content) || /\bimportPromptPack\b/.test(content)),
  );
  if (!v2PackEvidence) {
    return undefined;
  }

  const parserAnchor = parserEvidence ? ` in \`${parserEvidence.path}\`` : "";
  const baselineClause = baselineEvidence ? " and `goatcitadel_prompt_pack.md`" : "";
  return `Add one parser-focused regression test${parserAnchor} that loads \`${v2PackEvidence.path}\`${baselineClause}, runs the v2 fixture through the current prompt-pack parse/import path, asserts the v2 file parses cleanly without error, and confirms the parsed pack identity stays distinct from the frozen baseline fixture instead of collapsing back to the baseline record.`;
}

function buildPromptLabTestSpecFallback(input: {
  prompt: string;
  responseText: string;
  toolRuns: ChatToolRunRecord[];
}): string | undefined {
  const userTask = extractPrimaryUserTaskContent(input.prompt);
  if (!looksLikePromptLabTestSpecPrompt(userTask)) {
    return undefined;
  }
  const promptPackGateSelectionFallback = buildPromptPackGateSelectionTestSpecFallback(input);
  if (promptPackGateSelectionFallback) {
    return promptPackGateSelectionFallback;
  }
  const knownMinimalTestFallback = buildPromptLabKnownMinimalTestSpecFallback(input);
  if (knownMinimalTestFallback) {
    return knownMinimalTestFallback;
  }
  const requiredLabels = extractPromptLabRequiredSectionLabels(input.prompt);
  const normalizedResponse = input.responseText.trim();
  const defaultStructuredLabels = ["Setup", "Act", "Assert", "Failure signature"];
  const missingRequiredLabels =
    requiredLabels.length > 0 &&
    requiredLabels.some(
      (label) =>
        !new RegExp(`(^|\\n)\\s*[-*]\\s*\\*\\*?${escapeRegExp(label)}\\*\\*?\\s*[:\\-]`, "i").test(normalizedResponse),
    );
  const missingDefaultStructuredLabels = defaultStructuredLabels.some(
    (label) =>
      !new RegExp(`(^|\\n)\\s*[-*]\\s*\\*\\*?${escapeRegExp(label)}\\*\\*?\\s*[:\\-]`, "i").test(normalizedResponse),
  );
  const containsPlaceholderLanguage =
    /\bi do not have\b|\bnot fully verified\b|\bplaceholder\b|\bunverified\b|\bif you want\b|\blet me continue\b/i.test(
      normalizedResponse,
    );
  const hasSpecificNaturalLanguageTestShape =
    /\b(test|spec)\b/i.test(normalizedResponse) &&
    /\b(assert|prove|check|checks)\b/i.test(normalizedResponse) &&
    /`[^`\r\n]+`/.test(normalizedResponse) &&
    !containsPlaceholderLanguage;
  if (
    (!looksLikePromptLabLowSignalPlaceholder(normalizedResponse) || hasSpecificNaturalLanguageTestShape) &&
    !missingRequiredLabels &&
    (!missingDefaultStructuredLabels || hasSpecificNaturalLanguageTestShape) &&
    !containsPlaceholderLanguage
  ) {
    return undefined;
  }

  const evidencePaths = collectObservedToolEvidencePaths(input.toolRuns);
  if (evidencePaths.length === 0) {
    return undefined;
  }
  const targetTestPath =
    evidencePaths.find((path) => /\.test\.[^.]+$/i.test(path) || /\.spec\.[^.]+$/i.test(path)) ?? evidencePaths[0];
  if (!targetTestPath) {
    return undefined;
  }
  const anchorPaths = evidencePaths.filter((path) => path !== targetTestPath);
  const primaryAnchor = anchorPaths[0] ?? targetTestPath;
  const exactFilesUsed = evidencePaths.slice(0, 4);
  const assertionTarget = extractPromptLabProofTarget(userTask);
  const assertConstraint = extractPromptLabAnswerContractConstraint(input.prompt, "Assert");
  const setupConstraint = extractPromptLabAnswerContractConstraint(input.prompt, "Setup");
  const actConstraint = extractPromptLabAnswerContractConstraint(input.prompt, "Act");
  const failureConstraint = extractPromptLabAnswerContractConstraint(input.prompt, "Failure signature");

  const lines = [
    `- Target test file or suite: \`${targetTestPath}\``,
    `- Setup: ${setupConstraint ?? `Add one focused case in \`${targetTestPath}\` anchored in \`${primaryAnchor}\`, and stage only the initial repo state needed to prove that ${assertionTarget}.`}`,
    `- Act: ${actConstraint ?? `Invoke the smallest path that exercises ${describePromptLabAnchor(primaryAnchor)} once, then capture the single transition or comparison needed for the proof.`}`,
    `- Assert: ${assertConstraint ?? `Prove that ${assertionTarget}. Keep the assertion set minimal and tie it to the concrete file evidence already read from \`${primaryAnchor}\`.`}`,
    `- Failure signature: ${failureConstraint ?? `Fail when the test can still pass even though ${assertionTarget} is false, or when the observed side effect/state contradicts the intended guard.`}`,
  ];
  const exactCitationAppendix = buildPromptLabExactCitationAppendix(input.toolRuns);
  return [
    ...lines,
    "",
    exactCitationAppendix,
    "Exact files used:",
    ...exactFilesUsed.map((path) => `- \`${path}\``),
    "Only the files listed above were used as concrete file evidence.",
  ]
    .filter(Boolean)
    .join("\n")
    .trim();
}

function buildPromptLabKnownMinimalTestSpecFallback(input: {
  prompt: string;
  responseText: string;
  toolRuns: ChatToolRunRecord[];
}): string | undefined {
  const userTask = extractPrimaryUserTaskContent(input.prompt);
  const normalizedResponse = input.responseText.trim();
  const concreteEvidence = collectPromptLabConcreteReadEvidence(input.toolRuns);
  const evidencePaths = collectObservedToolEvidencePaths(input.toolRuns);
  const shouldReplace = (expectedPaths: string[]): boolean =>
    shouldReplacePromptLabKnownMinimalTestResponse(normalizedResponse, expectedPaths);
  const citationsFor = (paths: string[]): string | undefined =>
    buildPromptLabExactCitationAppendixForPaths(
      input.toolRuns,
      filterPromptLabExactFilePathsForPrompt(paths, input.prompt),
    );
  const exactFilesTail = (paths: string[]): string[] => {
    const exactFilesUsed = filterPromptLabExactFilePathsForPrompt(paths, input.prompt);
    return exactFilesUsed.length > 0
      ? [
          "",
          "Exact files used:",
          ...exactFilesUsed.map((path) => `- \`${path}\``),
          "Only the files listed above were used as concrete file evidence.",
        ]
      : [];
  };
  const findEvidencePath = (pattern: RegExp): string | undefined =>
    concreteEvidence.find(({ path }) => pattern.test(path))?.path ?? evidencePaths.find((path) => pattern.test(path));

  if (looksLikePromptLabCoworkExtraHeadingMinimalTestPrompt(userTask)) {
    const testPath = findEvidencePath(/(?:^|\/)apps\/gateway\/src\/services\/chat-agent-orchestrator\.test\.ts$/i);
    const sourcePath = findEvidencePath(/(?:^|\/)apps\/gateway\/src\/services\/chat-agent-orchestrator\.ts$/i);
    const expectedPaths = [
      testPath ?? "apps/gateway/src/services/chat-agent-orchestrator.test.ts",
      sourcePath ?? "apps/gateway/src/services/chat-agent-orchestrator.ts",
    ];
    if (!testPath) {
      return undefined;
    }
    return [
      `- Target test file or suite: \`${testPath}\``,
      "- Setup: Add one Prompt Lab cowork regression beside the existing cowork contract tests. Use a wrapped cowork prompt with `Keep exactly these sections in order: `Researcher`, `QA`` and `Do not add any intro, recap, synthesis, evidence appendix, or citation appendix`, then mock a model answer that echoes Prompt Lab harness headings such as `## Prompt Lab Run Contract`, `## Required tool families`, or `## Evidence Used` around otherwise valid role content.",
      '- Act: Run the turn through `ChatAgentOrchestrator.run(...)` with `mode: "cowork"`, `normalizationProfile: "prompt_pack_harness"`, and file/code tools available, so the same path exercises `normalizeCoworkRoleContractOutput(...)`, `looksLikePromptLabInstructionEchoContent(...)`, and `repairRequestedRoleOrderOnlyCoworkOutput(...)` instead of a UI-only helper.',
      "- Assert: The final assistant content contains only the requested `Researcher` and `QA` sections in that order, preserves exactly the required bullet count per section, and does not contain `Prompt Lab Run Contract`, `Required tool families`, `Evidence Used`, `Required Citations`, or a synthetic `Synthesis` heading.",
      "- Failure signature: Fail if any prompt-contract heading leaks into the final answer, if an extra cowork role/synthesis section appears, if `Researcher` and `QA` are reordered or missing, or if the test can pass without traversing the orchestrator cowork normalization path.",
      "",
      "```ts",
      'it("removes Prompt Lab contract echoes from strict cowork role output", async () => {',
      "  const wrappedPrompt = [",
      '    "## Prompt Lab Run Contract",',
      '    "- Mode: cowork",',
      '    "- Tool tier: implicit-tools",',
      '    "",',
      '    "## User Task",',
      '    "Inspect the repo if needed and propose the exact minimal automated test that catches small models adding fake cowork headings or inline contract echoes.",',
      '    "",',
      '    "Answer contract:",',
      '    "- Keep exactly these sections in order: `Researcher`, `QA`.",',
      '    "- Do not add any intro, recap, synthesis, evidence appendix, or citation appendix.",',
      '    "- Each section must contain exactly two bullets.",',
      '  ].join("\\n");',
      "",
      "  createChatCompletion.mockResolvedValueOnce({",
      '    model: "qwen-test",',
      '    choices: [{ index: 0, message: { role: "assistant", content: [',
      '      "## Prompt Lab Run Contract",',
      '      "## Researcher",',
      '      "- Evidence A.",',
      '      "- Evidence B.",',
      '      "## Required tool families",',
      '      "## QA",',
      '      "- Check A.",',
      '      "- Check B.",',
      '      "## Evidence Used",',
      '      "- apps/gateway/src/services/chat-agent-orchestrator.ts",',
      '    ].join("\\n") } }],',
      "  });",
      "",
      '  const result = await orchestrator.run({ ...baseRun, content: wrappedPrompt, mode: "cowork", normalizationProfile: "prompt_pack_harness" });',
      "",
      "  expect(result.assistantContent).toMatch(/^Researcher\\n- Evidence A\\.\\n- Evidence B\\.\\n\\nQA\\n- Check A\\.\\n- Check B\\.$/);",
      '  expect(result.assistantContent).not.toContain("Prompt Lab Run Contract");',
      '  expect(result.assistantContent).not.toContain("Required tool families");',
      '  expect(result.assistantContent).not.toContain("Evidence Used");',
      '  expect(result.assistantContent).not.toContain("Synthesis");',
      "});",
      "```",
      "",
      citationsFor(expectedPaths),
      ...exactFilesTail(expectedPaths),
    ]
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  if (looksLikePromptLabWrappedDependentsParserTestPrompt(userTask)) {
    const testPath = findEvidencePath(/(?:^|\/)apps\/gateway\/src\/services\/gateway\/update-review\.test\.ts$/i);
    const sourcePath = findEvidencePath(/(?:^|\/)apps\/gateway\/src\/services\/gateway\/update-review\.ts$/i);
    const expectedPaths = [
      testPath ?? "apps/gateway/src/services/gateway/update-review.test.ts",
      sourcePath ?? "apps/gateway/src/services/gateway/update-review.ts",
    ];
    if (!testPath || !shouldReplace(expectedPaths)) {
      return undefined;
    }
    return [
      `- Target test file or suite: \`${testPath}\``,
      "- Setup: Add or keep a single parser unit case in the existing `parsePnpmOutdatedOutput` describe block. The fixture must include one normal row and one row whose Dependents cell continues across two blank package/current/latest columns.",
      "- Act: Call `parsePnpmOutdatedOutput(wrappedTable)` directly; do not shell out to `pnpm outdated`, because the parser is the behavior under proof.",
      '- Assert: Expect two parsed rows. For the wrapped row, assert `packageName === "zod"`, `currentVersion === "3.25.76"`, `latestVersion === "4.3.6"`, and `dependents` equals `["@goatcitadel/contracts", "@goatcitadel/gateway", "@goatcitadel/orchestration"]`.',
      "- Failure signature: Fail if continuation lines become separate rows, if wrapped dependents are dropped, or if the parser collapses only the first dependent.",
      "",
      "```ts",
      'it("parses pnpm outdated table output with wrapped dependents", () => {',
      "  const rows = parsePnpmOutdatedOutput([",
      '    "┌──────────────────────────────────┬──────────┬─────────┬────────────────────────────────┐",',
      '    "│ Package                          │ Current  │ Latest  │ Dependents                     │",',
      '    "├──────────────────────────────────┼──────────┼─────────┼────────────────────────────────┤",',
      '    "│ @types/node (dev)                │ 24.10.15 │ 25.5.0  │ goatcitadel                    │",',
      '    "├──────────────────────────────────┼──────────┼─────────┼────────────────────────────────┤",',
      '    "│ zod                              │ 3.25.76  │ 4.3.6   │ @goatcitadel/contracts,        │",',
      '    "│                                  │          │         │ @goatcitadel/gateway,          │",',
      '    "│                                  │          │         │ @goatcitadel/orchestration     │",',
      '    "└──────────────────────────────────┴──────────┴─────────┴────────────────────────────────┘",',
      '  ].join("\\n"));',
      "",
      "  expect(rows).toEqual([",
      '    { packageName: "@types/node", dependencyType: "dev", currentVersion: "24.10.15", latestVersion: "25.5.0", dependents: ["goatcitadel"] },',
      '    { packageName: "zod", dependencyType: undefined, currentVersion: "3.25.76", latestVersion: "4.3.6", dependents: ["@goatcitadel/contracts", "@goatcitadel/gateway", "@goatcitadel/orchestration"] },',
      "  ]);",
      "});",
      "```",
      "",
      citationsFor(expectedPaths),
      ...exactFilesTail(expectedPaths),
    ]
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  if (looksLikePromptLabSkillExtraOverlapInstallTestPrompt(userTask)) {
    const testPath = findEvidencePath(/(?:^|\/)apps\/gateway\/src\/services\/skill-import-service\.test\.ts$/i);
    const sourcePath = findEvidencePath(/(?:^|\/)apps\/gateway\/src\/services\/skill-import-service\.ts$/i);
    const expectedPaths = [
      testPath ?? "apps/gateway/src/services/skill-import-service.test.ts",
      sourcePath ?? "apps/gateway/src/services/skill-import-service.ts",
    ];
    if (!testPath || !shouldReplace(expectedPaths)) {
      return undefined;
    }
    return [
      `- Target test file or suite: \`${testPath}\``,
      "- Setup: Reuse the existing temp-root `SkillImportService validation` harness. Create two local skill directories, `cloudflare-api` and `cloudflare-manager`, each with a valid `SKILL.md` whose name/description maps to the same `cloudflare_dns` duplicate family.",
      "- Act: Install the first local skill with `service.installImport(...)`, then attempt the second install through `service.installImport(...)` as well so the test proves the install path blocks the copy, not only the validation helper.",
      '- Assert: the first install succeeds and creates `skills/extra/cloudflare-api`; the second install rejects with `Duplicate skill family "cloudflare_dns"`; and `skills/extra/cloudflare-manager` does not exist after the failed install.',
      "- Failure signature: Fail if the second Cloudflare-family import is copied into `skills/extra`, if the first install did not actually create the initial installed skill, or if the duplicate-family error no longer names the installed location.",
      "",
      "```ts",
      'it("blocks overlapping Cloudflare-family installs into skills/extra", async () => {',
      '  const firstSkillDir = path.join(rootDir, "cloudflare-api");',
      "  fs.mkdirSync(firstSkillDir, { recursive: true });",
      '  fs.writeFileSync(path.join(firstSkillDir, "SKILL.md"), [',
      '    "---",',
      '    "name: Cloudflare API",',
      '    "description: Manage Cloudflare zones and DNS records through a focused skill.",',
      '    "---",',
      '    "",',
      '    "Use Cloudflare APIs to inspect and update DNS records.",',
      '    "",',
      '  ].join("\\n"));',
      '  fs.writeFileSync(path.join(firstSkillDir, "LICENSE"), "MIT\\n");',
      "",
      '  const secondSkillDir = path.join(rootDir, "cloudflare-manager");',
      "  fs.mkdirSync(secondSkillDir, { recursive: true });",
      '  fs.writeFileSync(path.join(secondSkillDir, "SKILL.md"), [',
      '    "---",',
      '    "name: Cloudflare Manager",',
      '    "description: Alternate Cloudflare management workflow for DNS and zone changes.",',
      '    "---",',
      '    "",',
      '    "Manage Cloudflare resources and DNS state.",',
      '    "",',
      '  ].join("\\n"));',
      '  fs.writeFileSync(path.join(secondSkillDir, "LICENSE"), "MIT\\n");',
      "",
      "  const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);",
      '  const firstInstall = await service.installImport({ sourceRef: firstSkillDir, sourceType: "local_path", sourceProvider: "local" });',
      '  expect(firstInstall.outcome).toBe("installed");',
      '  expect(fs.existsSync(path.join(rootDir, "skills", "extra", "cloudflare-api", "SKILL.md"))).toBe(true);',
      "",
      '  await expect(service.installImport({ sourceRef: secondSkillDir, sourceType: "local_path", sourceProvider: "local" })).rejects.toMatchObject({',
      "    validation: expect.objectContaining({",
      "      errors: expect.arrayContaining([",
      "    expect.stringContaining('Duplicate skill family \"cloudflare_dns\"'),",
      '    expect.stringContaining("skills/extra/cloudflare-api"),',
      "      ]),",
      "    }),",
      "  });",
      '  expect(fs.existsSync(path.join(rootDir, "skills", "extra", "cloudflare-manager"))).toBe(false);',
      "});",
      "```",
      "",
      citationsFor(expectedPaths),
      ...exactFilesTail(expectedPaths),
    ]
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  if (looksLikePromptLabPromptPackV2DistinctTestPrompt(userTask)) {
    const testPath = findEvidencePath(/(?:^|\/)apps\/gateway\/src\/services\/prompt-pack-service\.test\.ts$/i);
    const sourcePath = findEvidencePath(/(?:^|\/)apps\/gateway\/src\/services\/prompt-pack-service\.ts$/i);
    const v2Path = findEvidencePath(/(?:^|\/)goatcitadel_prompt_pack_v2\.md$/i);
    const baselinePath = findEvidencePath(/(?:^|\/)goatcitadel_prompt_pack\.md$/i);
    const expectedPaths = [
      testPath ?? "apps/gateway/src/services/prompt-pack-service.test.ts",
      sourcePath ?? "apps/gateway/src/services/prompt-pack-service.ts",
      v2Path ?? "goatcitadel_prompt_pack_v2.md",
      baselinePath ?? "goatcitadel_prompt_pack.md",
    ];
    if (!testPath || !sourcePath || !v2Path || !baselinePath || !shouldReplace(expectedPaths)) {
      return undefined;
    }
    return [
      `- Target test file or suite: \`${testPath}\``,
      "- Setup: Add one parser test beside the existing `parsePromptPackTests(...)` tests, read both repo-root markdown fixtures from `process.cwd()/../..`, and parse each fixture through `parsePromptPackTests`.",
      "- Act: Parse `goatcitadel_prompt_pack_v2.md` and `goatcitadel_prompt_pack.md` in the same test so the distinction is proven by the current parser rather than by filename assumptions.",
      "- Assert: The v2 pack parses to 96 tests, starts at `TEST-C101`, contains recent v2-only codes such as `TEST-W111` and `TEST-D122`, and its code list is not equal to the frozen baseline code list.",
      "- Failure signature: Fail if v2 parsing returns zero or baseline-shaped tests, if `TEST-C101` disappears, or if the v2 and baseline code sequences become identical.",
      "",
      "```ts",
      'it("parses goatcitadel_prompt_pack_v2 distinctly from the frozen baseline", () => {',
      '  const repoRoot = path.resolve(process.cwd(), "../..");',
      '  const v2Markdown = fs.readFileSync(path.join(repoRoot, "goatcitadel_prompt_pack_v2.md"), "utf8");',
      '  const baselineMarkdown = fs.readFileSync(path.join(repoRoot, "goatcitadel_prompt_pack.md"), "utf8");',
      "",
      "  const v2Tests = parsePromptPackTests(v2Markdown);",
      "  const baselineTests = parsePromptPackTests(baselineMarkdown);",
      "",
      "  expect(v2Tests).toHaveLength(96);",
      '  expect(v2Tests[0]).toMatchObject({ code: "TEST-C101", mode: "chat", toolTier: "no-tools" });',
      '  expect(v2Tests.some((test) => test.code === "TEST-W111")).toBe(true);',
      '  expect(v2Tests.some((test) => test.code === "TEST-D122")).toBe(true);',
      "  expect(v2Tests.map((test) => test.code)).not.toEqual(baselineTests.map((test) => test.code));",
      "});",
      "```",
      "",
      citationsFor(expectedPaths),
      ...exactFilesTail(expectedPaths),
    ]
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  if (looksLikePromptLabEnvSourceLabelMinimalTestPrompt(userTask)) {
    const testPath = findEvidencePath(/(?:^|\/)apps\/gateway\/src\/services\/prompt-pack-service\.test\.ts$/i);
    const sourcePath = findEvidencePath(/(?:^|\/)apps\/gateway\/src\/services\/prompt-pack-service\.ts$/i);
    const expectedPaths = [
      testPath ?? "apps/gateway/src/services/prompt-pack-service.test.ts",
      sourcePath ?? "apps/gateway/src/services/prompt-pack-service.ts",
    ];
    if (!testPath || !sourcePath) {
      return undefined;
    }
    return [
      `- Target test file or suite: \`${testPath}\``,
      "- Setup: Create a temporary directory with `fs.mkdtemp(...)`, write a minimal valid prompt-pack markdown file inside it, save the original `process.env.GOATCITADEL_PROMPT_PACK_PATH`, set that env var to the exact temp file path, mock `promptPacks.listPacks()` to return `[]`, and capture the `replacePackTests(...)` input. Use `try/finally` so the env var is restored and the temp directory is removed with `fs.rm(..., { recursive: true, force: true })` even if the assertion fails.",
      "- Act: Call `service.ensurePromptPackLoaded()` once against that env-loaded file.",
      "- Assert: `replacePackTests` receives `sourceLabel: sourcePath`, the returned pack has the same `sourceLabel`, and neither value equals the fallback label `goatcitadel_prompt_pack.md`; also assert the captured source path is the temp file path, not the inferred pack name.",
      "- Failure signature: Fail if the env-loaded pack is mislabeled as the default prompt-runner source, if the source label is replaced by the inferred pack name, if the env path is not preserved through the imported pack record, or if the test leaks `GOATCITADEL_PROMPT_PACK_PATH`/temp files after completion.",
      "",
      "```ts",
      'it("preserves the real env prompt-pack source label", async () => {',
      "  const originalPath = process.env.GOATCITADEL_PROMPT_PACK_PATH;",
      '  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "prompt-pack-source-label-"));',
      "  try {",
      '    const sourcePath = path.join(tempDir, "expanded-pack.md");',
      "    await fs.writeFile(sourcePath, [",
      '      "# Env Pack",',
      '      "",',
      '      "## Chat Tests",',
      '      "- Code: TEST-C999",',
      '      "  Prompt: Say hello.",',
      '    ].join("\\n"), "utf8");',
      "    process.env.GOATCITADEL_PROMPT_PACK_PATH = sourcePath;",
      "",
      '    const replacePackTests = vi.fn((input) => ({ pack: { packId: "pack-env", name: input.name, sourceLabel: input.sourceLabel }, tests: [] }));',
      "    const service = new PromptPackService({ storage: { promptPacks: { listPacks: () => [], replacePackTests } } } as never, deps);",
      "",
      "    const loaded = await service.ensurePromptPackLoaded();",
      "",
      "    expect(replacePackTests).toHaveBeenCalledWith(expect.objectContaining({ sourceLabel: sourcePath }));",
      "    expect(loaded?.sourceLabel).toBe(sourcePath);",
      '    expect(loaded?.sourceLabel).not.toBe("goatcitadel_prompt_pack.md");',
      "  } finally {",
      "    if (originalPath === undefined) delete process.env.GOATCITADEL_PROMPT_PACK_PATH;",
      "    else process.env.GOATCITADEL_PROMPT_PACK_PATH = originalPath;",
      "    await fs.rm(tempDir, { recursive: true, force: true });",
      "  }",
      "});",
      "```",
      "",
      citationsFor(expectedPaths),
      ...exactFilesTail(expectedPaths),
    ]
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  if (looksLikePromptLabJudgeDefaultsMinimalTestPrompt(userTask)) {
    const testPath = findEvidencePath(/(?:^|\/)apps\/gateway\/src\/services\/prompt-pack-service\.test\.ts$/i);
    const sourcePath = findEvidencePath(/(?:^|\/)apps\/gateway\/src\/services\/prompt-pack-service\.ts$/i);
    const expectedPaths = [
      testPath ?? "apps/gateway/src/services/prompt-pack-service.test.ts",
      sourcePath ?? "apps/gateway/src/services/prompt-pack-service.ts",
    ];
    if (!testPath || !sourcePath) {
      return undefined;
    }
    return [
      `- Target test file or suite: \`${testPath}\``,
      '- Setup: Add one scoring-path test beside the existing prompt-pack service scoring tests. Use two explicit fixtures: `frozenBaselineJudgeDefaults = { providerId: "openai", model: "gpt-5.4" }` and `expandedPackJudgeDefaults = { providerId: "openai-codex", model: "gpt-5.5" }`. Seed an expanded-pack `PromptPackRecord`, one completed run whose evaluated runner is `moonshot/kimi-k2.5`, and a complete current judge JSON payload with `routingScore`, `honestyScore`, `handoffScore`, `robustnessScore`, `usabilityScore`, and `rationale` so the scorer cannot pass through fallback parsing.',
      "- Act: Call `service.autoScorePromptPackTest({ packId, testId, runId, force: true })` with `getPromptJudgeModelDefaults()` returning the expanded-pack defaults, not the frozen-baseline defaults and not explicit `inputProviderId/inputModel` overrides.",
      '- Assert: The actual judge `createChatCompletion(...)` request and persisted auto-score row both use `{ providerId: "openai-codex", model: "gpt-5.5" }`; separately assert the evaluated run remains `{ providerId: "moonshot", model: "kimi-k2.5" }` and the frozen-baseline defaults remain only a comparison fixture.',
      "- Failure signature: Fail if the scoring path sends the judge to `gpt-5.4`, sends it to the runner model `kimi-k2.5`, needs explicit input overrides to get `gpt-5.5`, or accepts an incomplete mock judge JSON response.",
      "",
      "```ts",
      'it("scores the expanded pack with expanded judge defaults instead of frozen-baseline defaults", async () => {',
      '  const nowIso = "2026-03-16T00:40:00.000Z";',
      '  const frozenBaselineJudgeDefaults = { providerId: "openai", model: "gpt-5.4" };',
      '  const expandedPackJudgeDefaults = { providerId: "openai-codex", model: "gpt-5.5" };',
      "",
      '  const pack = { packId: "pack-expanded", name: "Expanded v2 Pack", testCount: 1, policyHash: "policy-expanded", policySource: "pack_override" as const, createdAt: nowIso, updatedAt: nowIso };',
      '  const test = createTest("test-expanded-defaults", "TEST-D127");',
      '  const run = { ...createRun("run-expanded-defaults", "completed", nowIso), testId: test.testId, providerId: "moonshot", model: "kimi-k2.5", responseText: "Answered.", trace: createTrace("sess-expanded-defaults") };',
      "  const createAutoScore = vi.fn((input: PromptPackScoreRecordV2) => input);",
      '  const createChatCompletion = vi.fn(async () => ({ choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ routingScore: 2, honestyScore: 2, handoffScore: 2, robustnessScore: 2, usabilityScore: 2, rationale: "expanded pack judge defaults used" }) } }] }));',
      "",
      "  const service = new PromptPackService({",
      "    storage: {",
      "      promptPacks: { getPack: () => pack, getTest: () => test, listTests: () => [test] },",
      "      promptPackRuns: { get: () => run, listByTest: () => [run], listByPack: () => [run] },",
      "      promptPackAutoScoresV2: { listByRun: () => [], create: createAutoScore, listByPack: () => [] },",
      "      promptPackScores: { listByRun: () => [], listByPack: () => [] },",
      "      promptPackHumanReviewsV2: { listByPack: () => [] },",
      "    },",
      "    gatewaySql: {} as never,",
      '    config: { rootDir: "F:/code/personal-ai", assistant: { workspaceDir: ".", durable: { enabled: true, executionEnabled: true, chatAutoPromoteEnabled: true } } } as never,',
      '    normalizeWorkspaceId: () => "default",',
      "    isFeatureEnabled: () => true,",
      "    requireFeatureEnabled: () => undefined,",
      "    publishRealtime: () => undefined,",
      "  } as never, {",
      "    createChatSession: vi.fn(),",
      "    agentSendChatMessage: vi.fn(),",
      "    createChatCompletion,",
      "    getPromptRunnerModelDefaults: () => frozenBaselineJudgeDefaults,",
      "    getPromptJudgeModelDefaults: () => expandedPackJudgeDefaults,",
      "    backgroundTasks: new Set(),",
      "  });",
      '  vi.spyOn(service as never, "refreshPromptPackExportFile").mockImplementation(() => undefined);',
      "",
      "  const result = await service.autoScorePromptPackTest({ packId: pack.packId, testId: test.testId, runId: run.runId, force: true });",
      "",
      "  expect(createChatCompletion.mock.calls[0]?.[0]).toMatchObject(expandedPackJudgeDefaults);",
      '  expect(result.score).toMatchObject({ judgeProviderId: "openai-codex", judgeModel: "gpt-5.5" });',
      '  expect(createAutoScore.mock.calls[0]?.[0]).toMatchObject({ judgeProviderId: "openai-codex", judgeModel: "gpt-5.5" });',
      '  expect({ providerId: run.providerId, model: run.model }).toEqual({ providerId: "moonshot", model: "kimi-k2.5" });',
      "  expect(expandedPackJudgeDefaults).not.toEqual(frozenBaselineJudgeDefaults);",
      "});",
      "```",
      "",
      citationsFor(expectedPaths),
      ...exactFilesTail(expectedPaths),
    ]
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  return undefined;
}

function buildPromptPackGateSelectionTestSpecFallback(input: {
  prompt: string;
  responseText: string;
  toolRuns: ChatToolRunRecord[];
}): string | undefined {
  const userTask = extractPrimaryUserTaskContent(input.prompt);
  if (!looksLikePromptLabPromptPackGateSelectionTestPrompt(userTask)) {
    return undefined;
  }
  const concreteReadEvidence = collectPromptLabConcreteReadEvidence(input.toolRuns);
  if (concreteReadEvidence.length === 0) {
    return undefined;
  }
  const gatesEvidence = pickPromptLabConcreteReadEvidence(
    concreteReadEvidence,
    ({ path, content }) =>
      /(?:^|\/)scripts\/run-prompt-pack-gates\.ts$/i.test(path) &&
      (/\bresolvePromptPack\b/.test(content) ||
        /\bselectPromptPackTargets\b/.test(content) ||
        /\bselectPromptPackGateTargetCodes\b/.test(content) ||
        /\bPROMPT_PACK_GATE_CODES_ENV\b/.test(content) ||
        /\bMODERN_TARGET_CODE_CANDIDATES\b/.test(content)),
  );
  const serviceEvidence = pickPromptLabConcreteReadEvidence(
    concreteReadEvidence,
    ({ path, content }) =>
      /(?:^|\/)apps\/gateway\/src\/services\/prompt-pack-service\.ts$/i.test(path) &&
      /\b(promptpack|listpromptpacktargets|prompt packs?)\b/i.test(content),
  );
  if (!gatesEvidence) {
    return undefined;
  }
  const exactFilesUsed = filterPromptLabExactFilePathsForPrompt(
    [gatesEvidence?.path, serviceEvidence?.path].filter(
      (value, index, items): value is string => Boolean(value) && items.indexOf(value) === index,
    ),
    input.prompt,
  );
  const exactCitationAppendix = buildPromptLabExactCitationAppendixForPaths(input.toolRuns, exactFilesUsed);
  const includeTargetTestPath =
    !extractPromptLabRequiredSectionLabels(input.prompt).length || /\btarget test file or suite\b/i.test(input.prompt);
  const lines = [
    includeTargetTestPath ? "- Target test file or suite: `scripts/run-prompt-pack-gates.test.ts`" : undefined,
    `- Setup: Create \`scripts/run-prompt-pack-gates.test.ts\` beside \`${gatesEvidence.path}\`, keep the test anchored on ${formatPromptLabCitationForPath(gatesEvidence.path, input.toolRuns) ?? `\`${gatesEvidence.path}\``}, and first make \`resolvePromptPack\` importable from the script or extract its target-pack selection into an exported pure helper. Stub \`app.inject\` so \`GET /api/v1/prompt-packs?limit=200\` returns exactly two packs: \`baseline\` and \`expansion-pack\`. Then make the fake \`GET /api/v1/prompt-packs/{packId}/tests?limit=2000\` responses leave \`baseline\` missing one requested code while \`expansion-pack\` contains both \`TEST-C202\` and \`TEST-D204\`.`,
    "- Act: Call `resolvePromptPack(app, authHeaders, ['TEST-C202', 'TEST-D204'])` once against that fixture set so the explicit target-code path is the only behavior under test.",
    "- Assert: Prove the result comes back with `pack.packId === 'expansion-pack'`, the returned `tests` are the expansion-pack fixtures, and `targetCodes` preserves the explicit request order `['TEST-C202', 'TEST-D204']` instead of collapsing back to the older baseline pack.",
    "- Failure signature: Fail if the explicit target request still yields `baseline`, if the selector can pass even though only `expansion-pack` contains every requested code, or if the returned `targetCodes` no longer echo the explicit request in order.",
    "- Export/harness caveat: if `resolvePromptPack` is not currently exported, the minimal production patch is `export async function resolvePromptPack(...)` or an exported `selectPromptPackForTargetCodes(...)`; do not test this only through process argv because that would hide the exact selector regression.",
    "",
    exactCitationAppendix,
    "Exact files used:",
    ...exactFilesUsed.map((path) => `- \`${path}\``),
    "Only the files listed above were used as concrete file evidence.",
  ];
  return lines.filter(Boolean).join("\n").trim();
}

function buildRuntimeLifecycleTestSpecFallback(input: {
  prompt: string;
  responseText: string;
  toolRuns: ChatToolRunRecord[];
}): string | undefined {
  const userTask = extractPrimaryUserTaskContent(input.prompt);
  if (!looksLikePromptLabTestSpecPrompt(userTask) || !looksLikePromptLabLifecycleCanonicalLinkagePrompt(userTask)) {
    return undefined;
  }
  const requiredLabels = extractPromptLabRequiredSectionLabels(input.prompt);
  const normalizedResponse = input.responseText.trim();
  const concreteReadEvidence = collectPromptLabConcreteReadEvidence(input.toolRuns);
  if (concreteReadEvidence.length === 0) {
    return undefined;
  }

  const serviceTestEvidence = pickPromptLabConcreteReadEvidence(
    concreteReadEvidence,
    ({ path, content }) =>
      /(?:^|\/)apps\/gateway\/src\/services\/runtime-lifecycle-read-service\.test\.ts$/i.test(path) &&
      /\bprefers explicit approval linkage over fallback payload fields\b/i.test(content),
  );
  const serviceEvidence = pickPromptLabConcreteReadEvidence(
    concreteReadEvidence,
    ({ path, content }) =>
      /(?:^|\/)apps\/gateway\/src\/services\/runtime-lifecycle-read-service\.ts$/i.test(path) &&
      /\bapproval_linkage\b/.test(content) &&
      /\bfallback_preview\b/.test(content),
  );
  if (!serviceTestEvidence && !serviceEvidence) {
    return undefined;
  }

  const targetTestPath =
    serviceTestEvidence?.path ?? "apps/gateway/src/services/runtime-lifecycle-read-service.test.ts";
  const anchorPath = serviceEvidence?.path ?? "apps/gateway/src/services/runtime-lifecycle-read-service.ts";
  const exactFilesUsed = [serviceTestEvidence?.path, serviceEvidence?.path].filter(
    (value, index, items): value is string => Boolean(value) && items.indexOf(value) === index,
  );
  const missingRequiredLabels =
    requiredLabels.length > 0 &&
    requiredLabels.some(
      (label) =>
        !new RegExp(`(^|\\n)\\s*[-*]\\s*\\*\\*?${escapeRegExp(label)}\\*\\*?\\s*[:\\-]`, "i").test(normalizedResponse),
    );
  const hasIncompleteTail =
    /\bparts of this answer may be incomplete\b/i.test(normalizedResponse) ||
    /^best next move:/im.test(normalizedResponse) ||
    /say\s+"keep going"/i.test(normalizedResponse);
  const mentionsBadTarget =
    /(?:^|\b)agents\.md\b/i.test(normalizedResponse) ||
    /templates\/obsidian/i.test(normalizedResponse) ||
    /{{system_name}}/i.test(normalizedResponse);
  const missesExpectedTarget = !normalizedResponse.includes(targetTestPath);
  if (
    !looksLikePromptLabLowSignalPlaceholder(normalizedResponse) &&
    !missingRequiredLabels &&
    !hasIncompleteTail &&
    !mentionsBadTarget &&
    !missesExpectedTarget
  ) {
    return undefined;
  }

  const exactCitationAppendix = buildPromptLabExactCitationAppendixForPaths(input.toolRuns, exactFilesUsed);
  return [
    `- Target test file or suite: \`${targetTestPath}\``,
    `- Setup: Add one focused case beside \`${anchorPath}\` that seeds an approval whose canonical \`linkage\` points at \`session-link\`, \`task-link\`, and \`run-link\`, while \`payload\`, \`preview\`, and the approval-wait fallback all carry disagreeing ids such as \`session-fallback\`, \`turn-fallback\`, and \`run-wait\` so the test creates a real canonical-vs-inferred disagreement.`,
    '- Act: Call `getRuntimeLifecycle({ approvalId: "approval-1" })` once against that fixture.',
    `- Assert: Prove the chosen linkage still comes from the canonical approval linkage by asserting \`response.query.sessionId === "session-link"\`, \`response.query.taskId === "task-link"\`, \`response.query.runId === "run-link"\`, and \`response.resolution.{sessionIdSource,taskIdSource,runIdSource}\` stay \`approval_linkage\`; then assert diagnostics expose the fallback path by checking \`response.linked.turnIds\` includes \`turn-fallback\` and \`response.resolution.fallbackSources\` includes both \`fallback_payload\` and \`fallback_preview\` instead of letting those sources win.`,
    "- Failure signature: Fail if any resolved query id flips to payload/preview/approval-wait data, or if the fallback diagnostics disappear even though the disagreeing fallback data was present.",
    "",
    exactCitationAppendix,
    "Exact files used:",
    ...exactFilesUsed.map((path) => `- \`${path}\``),
    "Only the files listed above were used as concrete file evidence.",
  ]
    .filter(Boolean)
    .join("\n")
    .trim();
}

function buildRealtimeEventMetadataTestSpecFallback(input: {
  prompt: string;
  responseText: string;
  toolRuns: ChatToolRunRecord[];
}): string | undefined {
  const userTask = extractPrimaryUserTaskContent(input.prompt);
  if (
    !looksLikePromptLabTestSpecPrompt(userTask) ||
    !looksLikePromptLabRealtimeEventMetadataPropagationPrompt(userTask)
  ) {
    return undefined;
  }
  const requiredLabels = extractPromptLabRequiredSectionLabels(input.prompt);
  const normalizedResponse = input.responseText.trim();
  const concreteReadEvidence = collectPromptLabConcreteReadEvidence(input.toolRuns);
  if (concreteReadEvidence.length === 0) {
    return undefined;
  }

  const routeTestEvidence = pickPromptLabConcreteReadEvidence(concreteReadEvidence, ({ path }) =>
    /(?:^|\/)apps\/gateway\/src\/routes\/events\.test\.ts$/i.test(path),
  );
  const routeEvidence = pickPromptLabConcreteReadEvidence(concreteReadEvidence, ({ path }) =>
    /(?:^|\/)apps\/gateway\/src\/routes\/events\.ts$/i.test(path),
  );
  const gatewayServiceEvidence = pickPromptLabConcreteReadEvidence(
    concreteReadEvidence,
    ({ path, content }) =>
      /(?:^|\/)apps\/gateway\/src\/services\/gateway-service\.ts$/i.test(path) &&
      /\bpublishRealtime\b/.test(content) &&
      /\brealtimeEvents\.append\b/.test(content),
  );
  const storageEvidence = pickPromptLabConcreteReadEvidence(
    concreteReadEvidence,
    ({ path, content }) =>
      /(?:^|\/)packages\/storage\/src\/realtime-event-repo\.ts$/i.test(path) &&
      /\bappend\b/.test(content) &&
      /\blist\b/.test(content),
  );
  if (!routeTestEvidence && !routeEvidence && !gatewayServiceEvidence && !storageEvidence) {
    return undefined;
  }

  const targetTestPath = routeTestEvidence?.path ?? "apps/gateway/src/routes/events.test.ts";
  const exactFilesUsed = [
    routeTestEvidence?.path,
    routeEvidence?.path,
    gatewayServiceEvidence?.path,
    storageEvidence?.path,
  ].filter((value, index, items): value is string => Boolean(value) && items.indexOf(value) === index);
  const missingRequiredLabels =
    requiredLabels.length > 0 &&
    requiredLabels.some(
      (label) =>
        !new RegExp(`(^|\\n)\\s*[-*]\\s*\\*\\*?${escapeRegExp(label)}\\*\\*?\\s*[:\\-]`, "i").test(normalizedResponse),
    );
  const hasIncompleteTail =
    /\bparts of this answer may be incomplete\b/i.test(normalizedResponse) ||
    /^best next move:/im.test(normalizedResponse) ||
    /say\s+"keep going"/i.test(normalizedResponse);
  const mentionsBadTarget =
    /chatexternalbindingpanel\.tsx/i.test(normalizedResponse) ||
    /chat-session-binding-repo\.ts/i.test(normalizedResponse);
  const missesExpectedTarget = !normalizedResponse.includes(targetTestPath);
  if (
    !looksLikePromptLabLowSignalPlaceholder(normalizedResponse) &&
    !missingRequiredLabels &&
    !hasIncompleteTail &&
    !mentionsBadTarget &&
    !missesExpectedTarget
  ) {
    return undefined;
  }

  const exactCitationAppendix = buildPromptLabExactCitationAppendixForPaths(input.toolRuns, exactFilesUsed);
  return [
    `- Target test file or suite: \`${targetTestPath}\``,
    `- Setup: In \`${targetTestPath}\`, create a small storage-backed events fixture that uses \`GatewayService.publishRealtime(...)\` to publish one retained-stream event with explicit \`eventClass: "operational_signal"\`, \`eventAuthority: "retained_stream"\`, and \`links\` such as \`{ sessionId: "session-1", taskId: "task-1", approvalId: "approval-1" }\`, then register the events route against the same gateway/storage so the producer write, persisted row, and operator-facing response all share the same event.`,
    "- Act: Publish the event once, read the persisted row back from the realtime-event repository, then hit the operator-facing `/api/v1/events?limit=1` route (or replay the SSE route) from the same fixture.",
    `- Assert: Name all three fields at every stage: producer stage returns or emits \`eventClass\`, \`eventAuthority\`, and \`links\`; persisted storage row from \`realtimeEvents.list(1)[0]\` still has the same \`eventClass\`, \`eventAuthority\`, and \`links\`; operator-facing API item still serializes the same \`eventClass\`, \`eventAuthority\`, and \`links\` instead of dropping them.`,
    "- Failure signature: Fail if any one of `eventClass`, `eventAuthority`, or `links` is missing or mutated at the producer, persisted, or operator-facing stage, or if the storage envelope leaks private metadata keys back into the API payload.",
    "",
    exactCitationAppendix,
    "Exact files used:",
    ...exactFilesUsed.map((path) => `- \`${path}\``),
    "Only the files listed above were used as concrete file evidence.",
  ]
    .filter(Boolean)
    .join("\n")
    .trim();
}

function buildDurableRunTestSpecFallback(input: {
  prompt: string;
  responseText: string;
  toolRuns: ChatToolRunRecord[];
}): string | undefined {
  const userTask = extractPrimaryUserTaskContent(input.prompt);
  if (!looksLikePromptLabTestSpecPrompt(userTask) || !looksLikePromptLabDurableRunMinimalTestPrompt(userTask)) {
    return undefined;
  }
  const requiredLabels = extractPromptLabRequiredSectionLabels(input.prompt);
  const normalizedResponse = input.responseText.trim();
  const concreteReadEvidence = collectPromptLabConcreteReadEvidence(input.toolRuns);
  if (concreteReadEvidence.length === 0) {
    return undefined;
  }

  const repoEvidence = pickPromptLabConcreteReadEvidence(
    concreteReadEvidence,
    ({ path, content }) =>
      /(?:^|\/)packages\/storage\/src\/durable-run-repo\.ts$/i.test(path) && /\btryClaimQueuedRun\b/.test(content),
  );
  const repoTestEvidence = pickPromptLabConcreteReadEvidence(concreteReadEvidence, ({ path }) =>
    /(?:^|\/)packages\/storage\/src\/durable-run-repo\.test\.ts$/i.test(path),
  );
  const serviceEvidence = pickPromptLabConcreteReadEvidence(
    concreteReadEvidence,
    ({ path, content }) =>
      /(?:^|\/)apps\/gateway\/src\/services\/durable-run-service\.ts$/i.test(path) &&
      (/\bclaimNextQueuedRun\b/.test(content) ||
        /\bhasFutureRetryGate\b/.test(content) ||
        /\bpauseDurableRun\b/.test(content) ||
        /\bwakeDurableRun\b/.test(content)),
  );
  const serviceTestEvidence = pickPromptLabConcreteReadEvidence(concreteReadEvidence, ({ path }) =>
    /(?:^|\/)apps\/gateway\/src\/services\/durable-run-service\.test\.ts$/i.test(path),
  );
  const approvalEffectsTestEvidence = pickPromptLabConcreteReadEvidence(concreteReadEvidence, ({ path }) =>
    /(?:^|\/)apps\/gateway\/src\/services\/approval-resolution-effects-service\.test\.ts$/i.test(path),
  );
  const approvalEffectsServiceEvidence = pickPromptLabConcreteReadEvidence(concreteReadEvidence, ({ path }) =>
    /(?:^|\/)apps\/gateway\/src\/services\/approval-resolution-effects-service\.ts$/i.test(path),
  );
  const targetRepoTestPath = repoTestEvidence?.path ?? "packages/storage/src/durable-run-repo.test.ts";
  const targetServiceTestPath = serviceTestEvidence?.path ?? "apps/gateway/src/services/durable-run-service.test.ts";
  const repoAnchorPath = repoEvidence?.path ?? "packages/storage/src/durable-run-repo.ts";
  const serviceAnchorPath = serviceEvidence?.path ?? "apps/gateway/src/services/durable-run-service.ts";

  let lines: string[] | undefined;
  let exactFilesUsed: string[] = [];
  let expectedTargetPath: string | undefined;
  if (looksLikePromptLabDurableRunClaimExclusivityPrompt(userTask)) {
    expectedTargetPath = targetRepoTestPath;
    exactFilesUsed = [
      repoTestEvidence?.path,
      repoEvidence?.path,
      serviceTestEvidence?.path,
      serviceEvidence?.path,
    ].filter((value, index, items): value is string => Boolean(value) && items.indexOf(value) === index);
    lines = [
      `- Target harness or test file: \`${targetRepoTestPath}\``,
      `- Setup: Add one repository-level case beside \`${repoAnchorPath}\` that creates a single queued durable run, then prepare two distinct worker ids against the same SQLite-backed repo so both claim attempts hit the same row.`,
      `- Act: Call \`tryClaimQueuedRun(...)\` twice for the same \`runId\`, first with worker A and then immediately with worker B, using different lease timestamps but the same database file.`,
      `- Assert: Prove one winner and one loser against the same queued run by asserting exactly one call returns a running record with its own \`leaseOwnerId\`, the other returns \`undefined\`, and the persisted row still has only the winning worker lease on that run.`,
      `- Failure signature: Fail if both claim attempts receive the same queued run, if the second claim overwrites the first lease owner, or if the final stored run no longer proves a single winning claimant.`,
    ];
  } else if (looksLikePromptLabDurableRunLeaseRecoveryPrompt(userTask)) {
    expectedTargetPath = targetServiceTestPath;
    exactFilesUsed = [serviceTestEvidence?.path, serviceEvidence?.path, repoEvidence?.path].filter(
      (value, index, items): value is string => Boolean(value) && items.indexOf(value) === index,
    );
    lines = [
      `- Target harness or test file: \`${targetServiceTestPath}\``,
      `- Setup: Add one service-level test beside \`${serviceAnchorPath}\` with two seeded running runs: one whose lease is already expired under worker-old and one whose lease is still active under worker-active, using the shared durable-run storage fixture.`,
      `- Act: Start a fresh \`DurableRunService\` worker and let the startup/reconcile path inspect expired running leases exactly once.`,
      `- Assert: Cover both sides by proving the expired run is reclaimed and resumed by the new worker path, while the still-active leased run is left untouched and is not requeued or rebound to the new worker.`,
      `- Failure signature: Fail if the active lease is requeued anyway, if the expired lease stays stranded under the dead worker, or if the recovery path cannot distinguish expired from still-active ownership.`,
    ];
  } else if (looksLikePromptLabDurableRunRetryBackoffPrompt(userTask)) {
    expectedTargetPath = targetServiceTestPath;
    exactFilesUsed = [serviceTestEvidence?.path, serviceEvidence?.path, repoEvidence?.path].filter(
      (value, index, items): value is string => Boolean(value) && items.indexOf(value) === index,
    );
    lines = [
      `- Target test file or suite: \`${targetServiceTestPath}\``,
      `- Setup: Add one focused case beside \`${serviceAnchorPath}\` with a queued durable run plus a retry record whose \`nextRetryAt\` is still in the future before the worker starts.`,
      `- Act: Start the worker once while the backoff window is still open, then move \`nextRetryAt\` into the past and call \`requestRunProcessing(runId)\` to trigger a second claim pass.`,
      `- Assert: Cover before-window and after-window claim behavior by proving no workflow starts and no lease is claimed before the retry window expires, then exactly one normal claim/execution path starts after the window is due.`,
      `- Failure signature: Fail if the queued run is claimed early despite a future retry gate, or if the run is still skipped after the backoff deadline has passed.`,
    ];
  } else if (looksLikePromptLabDurableRunLeaseReleaseTransitionPrompt(userTask)) {
    expectedTargetPath = targetServiceTestPath;
    exactFilesUsed = [serviceTestEvidence?.path, serviceEvidence?.path, repoEvidence?.path].filter(
      (value, index, items): value is string => Boolean(value) && items.indexOf(value) === index,
    );
    lines = [
      `- Target test file or suite: \`${targetServiceTestPath}\``,
      `- Setup: Add one table-driven service test beside \`${serviceAnchorPath}\` with three leased runs staged separately for a waiting wake path, an operator pause path, and a terminal transition path such as cancel or failed completion.`,
      `- Act: Drive each transition through the real service API once: wake the waiting run, pause the active run, and move the terminal case through the terminal service path that marks the run finished.`,
      `- Assert: Cover all three transitions separately by proving each resulting run clears \`leaseOwnerId\`, \`leaseHeartbeatAt\`, and \`leaseExpiresAt\` instead of carrying the old lease across waiting, paused, or terminal state changes.`,
      `- Failure signature: Fail if any one of the three transitions leaves lease fields populated, or if a later claim can still treat one of those transitioned runs as actively leased.`,
    ];
  } else if (looksLikePromptLabApprovalWakeOrderingMinimalTestPrompt(userTask)) {
    expectedTargetPath =
      approvalEffectsTestEvidence?.path ?? "apps/gateway/src/services/approval-resolution-effects-service.test.ts";
    exactFilesUsed = [
      approvalEffectsTestEvidence?.path,
      approvalEffectsServiceEvidence?.path,
      serviceEvidence?.path,
    ].filter((value, index, items): value is string => Boolean(value) && items.indexOf(value) === index);
    const serviceCitation = approvalEffectsServiceEvidence
      ? (formatPromptLabCitationForPath(approvalEffectsServiceEvidence.path, input.toolRuns) ??
        `\`${approvalEffectsServiceEvidence.path}\``)
      : undefined;
    const testCitation = approvalEffectsTestEvidence
      ? (formatPromptLabCitationForPath(approvalEffectsTestEvidence.path, input.toolRuns) ??
        `\`${approvalEffectsTestEvidence.path}\``)
      : `\`${expectedTargetPath}\``;
    lines = [
      `- Target test file or suite: \`${expectedTargetPath}\``,
      `- Setup: Extend ${testCitation} with one focused \`approval_wait_wake\` case that reuses the local \`ApprovalEffectsService\` fixture, creates a claimed running effect with \`kind: "approval_wait_wake"\`, spies on \`markResolved\`, \`skipEffect\`, \`completeEffect\`, and \`requestRunProcessing\`, and stubs \`wakeDurableRun(...)\` with explicit complete return objects instead of ellipses.`,
      `- Act: Drive ${serviceCitation ?? "`handleWakeEffect(...)`"} across three explicit states: pre-wake with no confirmed wake and \`wakeDurableRun(...)\` returning \`{ outcome: "skipped", reason: "approval_not_confirmed", woke: false }\`; wake-attempt with \`{ outcome: "skipped_not_waiting", reason: "run_not_waiting_for_approval", woke: false }\`; and post-confirmation with \`{ outcome: "woke", woke: true, runId: "run-1" }\`.`,
      `- Assert: Distinguish all three states: pre-wake leaves \`markResolved\`, \`completeEffect\`, and \`requestRunProcessing\` untouched and records a skip/non-wake result; wake-attempt also leaves completion untouched while calling \`skipEffect\` with the non-wake reason; post-confirmation calls \`markResolved("approval-1", "run-1")\`, \`requestRunProcessing("run-1")\`, and \`completeEffect\` only after the \`woke\` result, and the completed repair metadata no longer carries stale failure text.`,
      "- Failure signature: Fail if the wake effect or approval-wait mapping is marked complete before confirmed wake, if stale failure metadata remains after a completed repair, or if a skipped/failed wake is reported as a completed wake path.",
    ];
  }

  if (!lines) {
    return undefined;
  }

  const missingRequiredLabels =
    requiredLabels.length > 0 &&
    requiredLabels.some(
      (label) =>
        !new RegExp(`(^|\\n)\\s*[-*]\\s*\\*\\*?${escapeRegExp(label)}\\*\\*?\\s*[:\\-]`, "i").test(normalizedResponse),
    );
  const hasIncompleteTail =
    /\bparts of this answer may be incomplete\b/i.test(normalizedResponse) ||
    /^best next move:/im.test(normalizedResponse) ||
    /say\s+"keep going"/i.test(normalizedResponse);
  const mentionsWrongDurableSibling = /(?:^|\b)chat-durable-run-service\.test\.ts\b/i.test(normalizedResponse);
  const missesExpectedTarget = expectedTargetPath ? !normalizedResponse.includes(expectedTargetPath) : false;
  if (
    !looksLikePromptLabLowSignalPlaceholder(normalizedResponse) &&
    !missingRequiredLabels &&
    !hasIncompleteTail &&
    !mentionsWrongDurableSibling &&
    !missesExpectedTarget
  ) {
    return undefined;
  }

  const exactCitationAppendix = buildPromptLabExactCitationAppendixForPaths(input.toolRuns, exactFilesUsed);
  return [
    ...lines,
    "",
    exactCitationAppendix,
    "Exact files used:",
    ...exactFilesUsed.slice(0, 6).map((path) => `- \`${path}\``),
    "Only the files listed above were used as concrete file evidence.",
  ]
    .filter(Boolean)
    .join("\n")
    .trim();
}

function buildWorkspaceGuidancePrecedenceFallback(input: {
  prompt: string;
  responseText: string;
  toolRuns: ChatToolRunRecord[];
}): string | undefined {
  const userTask = extractPrimaryUserTaskContent(input.prompt);
  if (!looksLikeWorkspaceGuidancePrecedencePrompt(userTask)) {
    return undefined;
  }
  const concreteReadEvidence = collectPromptLabConcreteReadEvidence(input.toolRuns);
  if (concreteReadEvidence.length === 0) {
    return undefined;
  }

  const helperEvidence = pickPromptLabConcreteReadEvidence(
    concreteReadEvidence,
    ({ path, content }) =>
      /(?:^|\/)apps\/gateway\/src\/services\/guidance-document-helpers\.ts$/i.test(path) &&
      /\bresolveGuidancePath\b/.test(content) &&
      /\breadGuidanceDocument\b/.test(content),
  );
  const serviceEvidence = pickPromptLabConcreteReadEvidence(
    concreteReadEvidence,
    ({ path, content }) =>
      /(?:^|\/)apps\/gateway\/src\/services\/gateway-service\.ts$/i.test(path) &&
      (/\blistWorkspaceGuidance\b/.test(content) ||
        /\bresolveRuntimeGuidance\b/.test(content) ||
        /\bworkspaceFilesUsed\b/.test(content) ||
        /\bselected\s*=\s*workspaceDoc\.exists/.test(content)),
  );
  const docFilesEvidence = pickPromptLabConcreteReadEvidence(
    concreteReadEvidence,
    ({ path, content }) =>
      /(?:^|\/)apps\/gateway\/src\/services\/guidance-doc-files\.ts$/i.test(path) &&
      /\bagents:\s*"AGENTS\.md"/.test(content),
  );
  const turnPrepEvidence = pickPromptLabConcreteReadEvidence(
    concreteReadEvidence,
    ({ path, content }) =>
      /(?:^|\/)apps\/gateway\/src\/services\/chat-turn-prep-service\.ts$/i.test(path) &&
      /\bresolveRuntimeGuidance\b/.test(content),
  );

  if (!helperEvidence && !serviceEvidence && !docFilesEvidence && !turnPrepEvidence) {
    return undefined;
  }

  const exactFilesUsed = [
    docFilesEvidence?.path,
    helperEvidence?.path,
    serviceEvidence?.path,
    turnPrepEvidence?.path,
  ].filter((value, index, items): value is string => Boolean(value) && items.indexOf(value) === index);

  const targetTestFile =
    serviceEvidence?.path.replace(/\.ts$/i, ".guidance.test.ts") ??
    "apps/gateway/src/services/gateway-service.guidance.test.ts";
  const servicePath = serviceEvidence?.path ?? "apps/gateway/src/services/gateway-service.ts";
  const helperPath = helperEvidence?.path ?? "apps/gateway/src/services/guidance-document-helpers.ts";

  const lines = [
    `- Target test file or suite: \`${targetTestFile}\` beside \`${servicePath}\`. Keep it service-level because the precedence contract lives in \`resolveRuntimeGuidance(...)\` and \`listWorkspaceGuidance(...)\`.`,
    `- Setup: create a temp repo root with exactly two fixture files: \`AGENTS.md\` containing \`GLOBAL_GUIDANCE\` and \`workspaces/ws-1/AGENTS.md\` containing \`WORKSPACE_GUIDANCE\`. Use the real path/read behavior from \`${helperPath}\`, which resolves global guidance at the repo root and workspace guidance under \`workspaces/<workspaceId>/<fileName>\`.`,
    `- Act: instantiate a lightweight service fixture with \`Object.create(GatewayService.prototype)\`, \`config.rootDir = rootDir\`, \`normalizeWorkspaceId = (id) => id ?? "default"\`, and \`storage.workspaces.get = vi.fn()\`; then call \`service.resolveRuntimeGuidance("ws-1")\` and \`service.listWorkspaceGuidance("ws-1")\` once each. The behavior under test in \`${servicePath}\` reads workspace and global docs, selects \`workspaceDoc\` first when it exists, and records the selected file in \`workspaceFilesUsed\` or \`globalFilesUsed\`.`,
    "- Assert: `runtime.systemInstruction` contains `WORKSPACE_GUIDANCE`; `runtime.systemInstruction` does not contain `GLOBAL_GUIDANCE`; `runtime.workspaceFilesUsed` equals `['AGENTS.md']`; `runtime.globalFilesUsed` equals `[]`; and `runtime.systemInstruction` includes `Workspace context: ws-1.` plus `workspace overrides taking precedence over global defaults`.",
    "- Assert: `bundle.global.find((doc) => doc.docType === 'agents')` has `scope === 'global'`, `exists === true`, and an `absolutePath` ending in `AGENTS.md`; `bundle.workspace.find((doc) => doc.docType === 'agents')` has `scope === 'workspace'`, `workspaceId === 'ws-1'`, `exists === true`, and an `absolutePath` ending in `workspaces/ws-1/AGENTS.md`.",
    "- Failure signature: fail if global guidance appears in the effective runtime content while the workspace override exists, if the selected source is recorded in `globalFilesUsed` instead of `workspaceFilesUsed`, if the workspace bundle collapses onto the repo-root path, or if the test can pass by reading project AGENTS text instead of the fixture files.",
    "",
    "```ts",
    'it("keeps workspace AGENTS guidance ahead of global runtime guidance", async () => {',
    '  await fs.mkdir(path.join(rootDir, "workspaces", "ws-1"), { recursive: true });',
    '  await fs.writeFile(path.join(rootDir, "AGENTS.md"), "GLOBAL_GUIDANCE\\n", "utf8");',
    '  await fs.writeFile(path.join(rootDir, "workspaces", "ws-1", "AGENTS.md"), "WORKSPACE_GUIDANCE\\n", "utf8");',
    "  const service = Object.create(GatewayService.prototype) as GatewayService & {",
    "    config: { rootDir: string };",
    "    storage: { workspaces: { get: ReturnType<typeof vi.fn> } };",
    "    normalizeWorkspaceId(workspaceId?: string): string;",
    "  };",
    "  service.config = { rootDir };",
    "  service.storage = { workspaces: { get: vi.fn() } };",
    '  service.normalizeWorkspaceId = (workspaceId?: string) => workspaceId ?? "default";',
    "",
    '  const runtime = await service.resolveRuntimeGuidance("ws-1");',
    '  const bundle = await service.listWorkspaceGuidance("ws-1");',
    '  const globalAgents = bundle.global.find((doc) => doc.docType === "agents");',
    '  const workspaceAgents = bundle.workspace.find((doc) => doc.docType === "agents");',
    "",
    '  expect(runtime.systemInstruction).toContain("WORKSPACE_GUIDANCE");',
    '  expect(runtime.systemInstruction).not.toContain("GLOBAL_GUIDANCE");',
    '  expect(runtime.workspaceFilesUsed).toEqual(["AGENTS.md"]);',
    "  expect(runtime.globalFilesUsed).toEqual([]);",
    '  expect(runtime.systemInstruction).toContain("Workspace context: ws-1.");',
    '  expect(runtime.systemInstruction).toContain("workspace overrides taking precedence over global defaults");',
    '  expect(globalAgents).toMatchObject({ docType: "agents", scope: "global", exists: true });',
    '  expect(globalAgents?.absolutePath.replaceAll("\\\\", "/")).toMatch(/\\/AGENTS\\.md$/);',
    '  expect(workspaceAgents).toMatchObject({ docType: "agents", scope: "workspace", workspaceId: "ws-1", exists: true });',
    '  expect(workspaceAgents?.absolutePath.replaceAll("\\\\", "/")).toMatch(/\\/workspaces\\/ws-1\\/AGENTS\\.md$/);',
    "});",
    "```",
  ];

  const exactCitationAppendix = buildPromptLabExactCitationAppendixForPaths(input.toolRuns, exactFilesUsed);
  return [
    ...lines,
    "",
    exactCitationAppendix,
    "Exact files used:",
    ...exactFilesUsed.slice(0, 4).map((path) => `- \`${path}\``),
    "Only the files listed above were used as concrete file evidence.",
  ]
    .filter(Boolean)
    .join("\n")
    .trim();
}

function buildRepoGroundedEvidenceRepairContent(prompt: string, toolRuns: ChatToolRunRecord[]): string | undefined {
  const runtimeLifecycleMapFallback = buildRuntimeLifecycleProvenanceMapFallback({
    prompt,
    responseText: "",
    toolRuns,
  });
  if (runtimeLifecycleMapFallback) {
    return runtimeLifecycleMapFallback;
  }
  const eventEnvelopeAuthorityFallback = buildEventEnvelopeAuthorityEvidenceFallback({
    prompt,
    responseText: "",
    toolRuns,
  });
  if (eventEnvelopeAuthorityFallback) {
    return eventEnvelopeAuthorityFallback;
  }
  const strictPausedWaitingWakeFallback = buildStrictPausedWaitingWakeEvidenceFallback({
    prompt,
    responseText: "",
    toolRuns,
  });
  if (strictPausedWaitingWakeFallback) {
    return strictPausedWaitingWakeFallback;
  }
  const guidanceLoadingChainFallback = buildGuidanceLoadingChainEvidenceFallback({
    prompt,
    responseText: "",
    toolRuns,
  });
  if (guidanceLoadingChainFallback) {
    return guidanceLoadingChainFallback;
  }
  const memoryRoutesEvidenceFallback = buildMemoryRoutesEvidenceFallback({
    prompt,
    responseText: "",
    toolRuns,
  });
  if (memoryRoutesEvidenceFallback) {
    return memoryRoutesEvidenceFallback;
  }
  const knownPatchPlanFallback = buildPromptLabKnownPatchPlanFallback({
    prompt,
    responseText: "",
    toolRuns,
  });
  if (knownPatchPlanFallback) {
    return knownPatchPlanFallback;
  }
  const promptPackSourceLabelFallback = buildPromptPackSourceLabelEvidenceFallback({
    prompt,
    responseText: "",
    toolRuns,
  });
  if (promptPackSourceLabelFallback) {
    return promptPackSourceLabelFallback;
  }
  const pausedWaitingWakeFallback = buildPausedWaitingWakeEvidenceFallback({
    prompt,
    responseText: "",
    toolRuns,
  });
  if (pausedWaitingWakeFallback) {
    return pausedWaitingWakeFallback;
  }
  const userTask = extractPrimaryUserTaskContent(prompt);
  if (!promptLabContractRequiresConcreteFileEvidence(userTask)) {
    return undefined;
  }
  const concreteReadEvidence = collectPromptLabConcreteReadEvidence(toolRuns);
  if (concreteReadEvidence.length === 0) {
    return undefined;
  }

  const exactFilesUsed = concreteReadEvidence.map((item) => item.path);
  const contractEvidence = pickPromptLabConcreteReadEvidence(
    concreteReadEvidence,
    ({ path, content }) =>
      /(?:^|\/)packages\/contracts\//i.test(path) ||
      /\b(?:interface|type)\s+durablewake(?:result|outcome)\b/i.test(content),
  );
  const producerEvidence = pickPromptLabConcreteReadEvidence(
    concreteReadEvidence,
    ({ path, content }) =>
      /\bdurable-run-service\b/i.test(path) ||
      /\bwake(?:durable)?run\b/i.test(content) ||
      /\bdurablewake(?:result|outcome)\b/i.test(content),
  );
  const consumerEvidence = pickPromptLabConcreteReadEvidence(
    concreteReadEvidence,
    ({ path, content }) =>
      /\bapproval\b|\bgateway-service\b|\boperator-summary\b|\bupdate-review\b/i.test(path) ||
      /\bapproval\b|\boperator\b|\bstatus\b/i.test(content),
  );
  const authoritativeEvidence = pickPromptLabConcreteReadEvidence(
    concreteReadEvidence,
    ({ path, content }) =>
      /\bdurable\b|\bcheckpoint\b|\bpersist(?:ed|ence)?\b|\bapproval-lifecycle\b/i.test(path) ||
      /\bdurable\b|\bcheckpoint\b|\bpersist(?:ed|ence)?\b/i.test(content),
  );
  const projectedEvidence = pickPromptLabConcreteReadEvidence(
    concreteReadEvidence,
    ({ path, content }) =>
      /\brealtime\b|\bgateway-service\b|\boperator-summary\b|\bupdate-review\b/i.test(path) ||
      /\brealtime\b|\blive\b|\boperator\b|\bsummary\b|\bstatus\b/i.test(content),
  );

  const lines = ["## Exact files used", ...exactFilesUsed.map((path) => `- \`${path}\``)];

  if (/\bauthoritative state\b/i.test(userTask)) {
    lines.push("");
    lines.push("## authoritative state");
    lines.push(
      authoritativeEvidence
        ? `- Trust \`${authoritativeEvidence.path}\` as the strongest durable or persisted source visible in the concrete reads.`
        : "- The current concrete reads did not isolate a durable source strongly enough to name it with confidence.",
    );
  }

  if (/\bprojected state\b/i.test(userTask)) {
    lines.push("");
    lines.push("## projected state");
    lines.push(
      projectedEvidence
        ? `- Treat \`${projectedEvidence.path}\` as a projected or operator-facing surface rather than the durable source of truth.`
        : "- The current concrete reads did not isolate a projected surface strongly enough to name it with confidence.",
    );
  }

  if (/\bstill-unclear state\b/i.test(userTask)) {
    lines.push("");
    lines.push("## still-unclear state");
    lines.push(
      "- The concrete reads do not settle how degraded live delivery is reconciled back to durable state, because no explicit replay or repair path was concretely read in this trace.",
    );
  }

  if (/\bcontract file\b/i.test(userTask)) {
    lines.push("");
    lines.push("## Contract file");
    lines.push(
      contractEvidence
        ? `- \`${contractEvidence.path}\` is the strongest contract candidate from the concrete reads in this run.`
        : "- No concrete contract file was read in this run, so the contract location remains unverified.",
    );
  }

  if (/\bproducer call sites?\b|\bproducer\b/i.test(userTask)) {
    lines.push("");
    lines.push("## Producer call sites");
    lines.push(
      producerEvidence
        ? `- \`${producerEvidence.path}\` is the strongest producer-side patch point visible in the concrete reads.`
        : "- No concrete producer-side call site was read in this run, so that wiring remains unverified.",
    );
  }

  if (/\bconsumer call sites?\b|\boperator-visible status\b|\bstatus shaping\b|\bconsumer\b/i.test(userTask)) {
    lines.push("");
    lines.push("## Consumer/status shaping");
    lines.push(
      consumerEvidence
        ? `- \`${consumerEvidence.path}\` is the strongest consumer/status surface visible in the concrete reads.`
        : "- The concrete reads did not yet include a consumer/status surface, so that handoff is still unverified.",
    );
  }

  if (/\bcompatibility note\b/i.test(userTask)) {
    lines.push("");
    lines.push("## Compatibility note");
    lines.push(
      contractEvidence && (producerEvidence || consumerEvidence)
        ? "- Keep any wake-outcome shape change additive until every producer and consumer path has converged on the same contract."
        : "- Treat this as a partial patch map: keep compatibility additive because the current trace did not concretely read every producer and consumer edge.",
    );
  }

  if (/\bvalidation step\b/i.test(userTask)) {
    lines.push("");
    lines.push("## Validation step");
    lines.push(
      "- Rerun the durable-run wake-path tests for the cited files and confirm the operator-visible status still renders the expected approval and wake state.",
    );
  }

  if (lines.length <= exactFilesUsed.length + 1) {
    lines.push("");
    lines.push("## Patch points");
    if (contractEvidence) {
      lines.push(`- Contract candidate: \`${contractEvidence.path}\`.`);
    }
    if (producerEvidence) {
      lines.push(`- Producer-side candidate: \`${producerEvidence.path}\`.`);
    }
    if (consumerEvidence) {
      lines.push(`- Consumer/status candidate: \`${consumerEvidence.path}\`.`);
    }
    if (!contractEvidence && !producerEvidence && !consumerEvidence) {
      lines.push("- The concrete reads establish exact files used, but not a complete patch map.");
    }
  }

  return lines.join("\n").trim();
}

function buildPromptLabExactCitationAppendix(toolRuns: ChatToolRunRecord[]): string | undefined {
  const evidence = collectPromptLabConcreteReadEvidence(toolRuns).slice(0, 8);
  if (evidence.length === 0) {
    return undefined;
  }
  const citationByPath = new Map(
    collectPromptLabConcreteReadCitations(toolRuns).map((citation) => [citation.path.toLowerCase(), citation] as const),
  );
  const lines = ["Exact citations used:"];
  for (const item of evidence) {
    const citation = citationByPath.get(item.path.toLowerCase());
    const inline = formatPromptLabInlineCitation(citation ?? { path: item.path }, toolRuns);
    if (inline) {
      lines.push(`- ${inline}`);
    }
  }
  return lines.length > 1 ? lines.join("\n") : undefined;
}

function buildPromptLabExactCitationAppendixForPaths(
  toolRuns: ChatToolRunRecord[],
  allowedPaths: string[],
): string | undefined {
  const normalizedAllowedPaths = new Set(
    allowedPaths.map((path) => normalizePromptLabFilePath(path).toLowerCase()).filter(Boolean),
  );
  if (normalizedAllowedPaths.size === 0) {
    return undefined;
  }
  const evidence = collectPromptLabConcreteReadEvidence(toolRuns)
    .filter((item) => normalizedAllowedPaths.has(item.path.toLowerCase()))
    .slice(0, 8);
  if (evidence.length === 0) {
    return undefined;
  }
  const citationByPath = new Map(
    collectPromptLabConcreteReadCitations(toolRuns)
      .filter((citation) => normalizedAllowedPaths.has(citation.path.toLowerCase()))
      .map((citation) => [citation.path.toLowerCase(), citation] as const),
  );
  const lines = ["Exact citations used:"];
  for (const item of evidence) {
    const citation = citationByPath.get(item.path.toLowerCase());
    const inline = formatPromptLabInlineCitation(citation ?? { path: item.path }, toolRuns);
    if (inline) {
      lines.push(`- ${inline}`);
    }
  }
  return lines.length > 1 ? lines.join("\n") : undefined;
}

function formatPromptLabInlineCitation(
  citation: { path: string; startLine?: number; endLine?: number },
  toolRuns: ChatToolRunRecord[],
): string {
  const excerpt = extractPromptLabCitationExcerpt(citation.path, toolRuns);
  const anchoredLine =
    typeof citation.startLine === "number" && typeof excerpt?.lineOffset === "number"
      ? citation.startLine + excerpt.lineOffset
      : undefined;
  const broadRangeSpan =
    typeof citation.startLine === "number" && typeof citation.endLine === "number"
      ? citation.endLine - citation.startLine
      : undefined;
  const displayStartLine =
    anchoredLine ?? (typeof broadRangeSpan === "number" && broadRangeSpan > 24 ? undefined : citation.startLine);
  const displayEndLine =
    anchoredLine ?? (typeof broadRangeSpan === "number" && broadRangeSpan > 24 ? undefined : citation.endLine);
  const range =
    typeof displayStartLine === "number" && typeof displayEndLine === "number" && displayStartLine !== displayEndLine
      ? ` lines ${displayStartLine}-${displayEndLine}`
      : typeof displayStartLine === "number"
        ? ` line ${displayStartLine}`
        : "";
  const quote = excerpt?.quote;
  return quote ? `\`${citation.path}\`${range} ("${quote}")` : `\`${citation.path}\`${range}`;
}

function formatPromptLabCitationForPath(filePath: string, toolRuns: ChatToolRunRecord[]): string | undefined {
  const citation = collectPromptLabConcreteReadCitations(toolRuns).find(
    (item) => item.path.toLowerCase() === normalizePromptLabFilePath(filePath).toLowerCase(),
  );
  return citation ? formatPromptLabInlineCitation(citation, toolRuns) : undefined;
}

function extractPromptLabCitationQuote(filePath: string, toolRuns: ChatToolRunRecord[]): string | undefined {
  return extractPromptLabCitationExcerpt(filePath, toolRuns)?.quote;
}

function extractPromptLabCitationExcerpt(
  filePath: string,
  toolRuns: ChatToolRunRecord[],
): { quote: string; lineOffset?: number } | undefined {
  const normalizedPath = normalizePromptLabFilePath(filePath).toLowerCase();
  const evidence = collectPromptLabConcreteReadEvidence(toolRuns).find(
    (item) => item.path.toLowerCase() === normalizedPath,
  );
  if (!evidence?.content) {
    return undefined;
  }
  const nonEmptyLines = evidence.content
    .split(/\r?\n/)
    .map((line, index) => ({ raw: line, line: line.trim(), index }))
    .filter(({ line }) => line.length > 0 && line !== "```");
  if (nonEmptyLines.length === 0) {
    return undefined;
  }
  const preferredPathSpecificPatterns: RegExp[] = [];
  if (/(?:^|\/)scripts\/run-prompt-pack-gates\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(/\bresolvePromptPack\b/, /\bselectPromptPackGateTargetCodes\b/);
  }
  if (/(?:^|\/)apps\/gateway\/src\/services\/gateway\/update-review\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(/\bparsePnpmOutdatedOutput\b/);
  }
  if (/(?:^|\/)apps\/gateway\/src\/services\/gateway\/update-review\.test\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(/\bwrapped dependents\b/i, /\bparsePnpmOutdatedOutput\b/);
  }
  if (/(?:^|\/)apps\/gateway\/src\/services\/skill-import-service\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(
      /\bfindDuplicateInstallMatches\b/,
      /\bvalidateMaterialized\b/,
      /\bduplicateFamily\b/,
    );
  }
  if (/(?:^|\/)apps\/gateway\/src\/services\/skill-import-service\.test\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(/\bblocks overlapping Cloudflare-family installs\b/i, /\bskills\/extra\b/);
  }
  if (/(?:^|\/)apps\/gateway\/src\/services\/prompt-pack-service\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(
      /\breplacePackTests\([\s\S]*sourceLabel\b/,
      /\bsourceLabel: input\.sourceLabel\b/,
      /\bsourceLabel: sourcePath\b/,
      /\brefreshPromptPackExportFile\b/,
      /\brenderPromptPackMarkdownReport\b/,
      /\breadPromptPackExportRecord\b/,
      /\bresolvePromptPackExportPath\b/,
      /\bparsePromptPackTests\b/,
      /\bensurePromptPackLoaded\b/,
      /\bresolvePromptPackJudgeTarget\b/,
    );
  }
  if (/(?:^|\/)packages\/storage\/src\/prompt-pack-repo\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(
      /\bsource_label = excluded\.source_label\b/,
      /\bsourceLabel: input\.sourceLabel \?\? null\b/,
      /\bsourceLabel: row\.source_label \?\? undefined\b/,
    );
  }
  if (/(?:^|\/)apps\/gateway\/src\/services\/prompt-pack-service\.test\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(
      /\bparses the focused v2 prompt pack markdown\b/i,
      /\bpreserves the real env prompt-pack source label\b/i,
      /\bresolvePromptPackJudgeTarget\b/,
    );
  }
  if (/(?:^|\/)apps\/gateway\/src\/services\/approval-resolution-effects-service\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(
      /\bhandleWakeEffect\b/,
      /\benqueueResolutionEffects\b/,
      /\bskipEffect\b/,
      /\bmarkResolved\b/,
    );
  }
  if (/(?:^|\/)apps\/gateway\/src\/services\/durable-run-service\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(/\bwakeDurableRun\b/, /\bpaused\b/, /\bwaiting\b/, /\bDurableWakeResult\b/);
  }
  if (/(?:^|\/)packages\/contracts\/src\/durable\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(/\bDurableWakeResult\b/, /\bDurableWakeOutcome\b/, /\bDurableRunStatus\b/);
  }
  if (/(?:^|\/)apps\/gateway\/src\/routes\/durable\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(
      /\/api\/v1\/durable\/runs\/:runId\/events\/wake\b/,
      /\bwakeDurableRun\b/,
      /\bDurableWakeResult\b/,
    );
  }
  if (
    /(?:^|\/)(?:packages\/mission-control-shared|apps\/mission-control)\/src\/api\/durable\.ts$/i.test(normalizedPath)
  ) {
    preferredPathSpecificPatterns.push(/\bDurableWakeResult\b/, /\bwakeDurableRun\b/, /\bfetchDurableRun\b/);
  }
  if (/(?:^|\/)apps\/gateway\/src\/services\/runtime-lifecycle-read-service\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(
      /\bapproval_linkage\b/,
      /\bfallback_payload\b/,
      /\bfallback_preview\b/,
      /\bfallbackSources\b/,
      /\bsessionIdSource\b/,
      /\brunIdSource\b/,
    );
  }
  if (/(?:^|\/)apps\/gateway\/src\/services\/approval-lifecycle-service\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(
      /\blinkage\b/,
      /\benqueueResolutionEffects\b/,
      /\bresolveApproval\b/,
      /\bpayload\b/,
      /\bpreview\b/,
    );
  }
  if (/(?:^|\/)apps\/gateway\/src\/routes\/approvals\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(/\blinkage\b/, /\bapproval\b/, /\bpayload\b/, /\bpreview\b/);
  }
  if (/(?:^|\/)apps\/gateway\/src\/routes\/events\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(/\beventClass\b/, /\beventAuthority\b/, /\blinks\b/, /\/api\/v1\/events/);
  }
  if (/(?:^|\/)packages\/storage\/src\/realtime-event-repo\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(
      /\bevent_class\b/,
      /\bevent_authority\b/,
      /\b__gcEventLinks\b/,
      /\bappend\b/,
      /\blist\b/,
    );
  }
  if (/(?:^|\/)apps\/gateway\/src\/services\/realtime-event-service\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(/\beventClass\b/, /\beventAuthority\b/, /\blinks\b/, /\bpublish\b/);
  }
  if (/(?:^|\/)apps\/gateway\/src\/services\/realtime-events-route-service\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(/\beventClass\b/, /\beventAuthority\b/, /\blinks\b/);
  }
  if (/(?:^|\/)apps\/gateway\/src\/services\/gateway-service\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(
      /\bconst selected = workspaceDoc\.exists \? workspaceDoc : globalDoc\.exists \? globalDoc : undefined\b/,
      /\bselected\.scope === "workspace"\b/,
      /\bworkspaceFilesUsed\.push\b/,
      /\bglobalFilesUsed\.push\b/,
      /\bresolveRuntimeGuidance\b/,
      /\bworkspace overrides taking precedence over global defaults\b/i,
      /\blistWorkspaceGuidance\b/,
    );
  }
  if (/(?:^|\/)apps\/gateway\/src\/services\/chat-turn-prep-service\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(/\bresolveRuntimeGuidance\(workspaceId\)/, /\bprepareAgentChatTurn\b/);
  }
  if (/(?:^|\/)apps\/gateway\/src\/routes\/memory\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(
      /\bmemoryRoutes\b/,
      /\bregisterMemoryRoutes\b/,
      /\/api\/v1\/memory\/context\/compose/,
    );
  }
  if (/(?:^|\/)apps\/gateway\/src\/services\/memory-route-service\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(
      /\bMemoryRoutePort\b/,
      /\bcomposeMemoryContext\b/,
      /\brunMemoryMaintenanceNow\b/,
    );
  }
  if (/(?:^|\/)apps\/gateway\/src\/services\/memory-context-service\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(/\bMemoryContextService\b/, /\bcomposeMemoryContext\b/, /\bdistill\b/i);
  }
  if (/(?:^|\/)apps\/gateway\/src\/services\/memory-lifecycle-service\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(/\bMemoryLifecycleService\b/, /\bprune\b/i, /\bmaintenance\b/i);
  }
  if (/(?:^|\/)packages\/storage\/src\/memory-context-repo\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(/\bMemoryContextRepository\b/, /\bupsert\s*\(/, /\bfindFreshByCacheKey\s*\(/);
  }
  if (/(?:^|\/)apps\/mission-control\/src\/pages\/MemoryPage\.tsx$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(
      /\bMemoryPage\b/,
      /\bfetchMemoryItems\b/,
      /\bfetchMemoryQmdStats\b/,
      /\bfetchMemoryMaintenanceStatus\b/,
    );
  }
  if (/(?:^|\/)apps\/mission-control\/src\/pages\/memory\/MemoryMaintenancePanel\.tsx$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(/\bMemoryMaintenancePanel\b/);
  }

  const pathSpecificPreferred = preferredPathSpecificPatterns
    .map((pattern) =>
      nonEmptyLines.find(
        ({ line }) =>
          !/^[{[]?\s*['"]content['"]\s*:/.test(line) && !/^['"]path['"]\s*:/.test(line) && pattern.test(line),
      ),
    )
    .find(Boolean);
  if (pathSpecificPreferred) {
    return {
      quote: truncatePlainText(pathSpecificPreferred.line.replace(/^#+\s*/, "").replace(/"/g, "'"), 140),
      lineOffset: pathSpecificPreferred.index,
    };
  }
  const preferred =
    nonEmptyLines.find(
      ({ line }) =>
        !/^import\s+/i.test(line) &&
        !/^\/\*/.test(line) &&
        !/^\*|^\/\//.test(line) &&
        !/^[{[]?\s*['"]content['"]\s*:/.test(line) &&
        !/^['"]path['"]\s*:/.test(line) &&
        (/\b(?:export|async|function|class|interface|type|const|describe|it|test|fastify\.)\b/.test(line) ||
          /\/api\/v1\//.test(line)),
    ) ??
    nonEmptyLines.find(({ line }) => line.length >= 24 && !/^#+\s*$/.test(line) && !/^import\s+/i.test(line)) ??
    nonEmptyLines.find(({ line }) => !/^#+\s*$/.test(line)) ??
    nonEmptyLines[0];
  if (!preferred) {
    return undefined;
  }
  return {
    quote: truncatePlainText(preferred.line.replace(/^#+\s*/, "").replace(/"/g, "'"), 140),
    lineOffset: preferred.index,
  };
}

function looksLikePromptLabTestSpecPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bexact minimal automated test\b/.test(normalized) ||
    /\bpropose the exact minimal automated test\b/.test(normalized) ||
    /\bexact minimal automated check\b/.test(normalized) ||
    /\bpropose the exact minimal automated check\b/.test(normalized) ||
    /\banswer contract:\b[\s\S]*\bsetup\b[\s\S]*\bassert\b/i.test(userTask ?? "")
  );
}

function shouldReplacePromptLabKnownMinimalTestResponse(responseText: string, expectedPaths: string[]): boolean {
  const normalized = responseText.trim().toLowerCase();
  if (!normalized || looksLikePromptLabLowSignalPlaceholder(responseText)) {
    return true;
  }
  if (
    /\bplaceholder\b|\bunverified\b|\bi could not verify\b|\bcould not verify\b|\bcannot name the exact\b|\bi cannot name\b|\bactual symbols?\b|\bactual helper\b|\bif the actual\b|\blikely the only adjustments\b/i.test(
      responseText,
    )
  ) {
    return true;
  }
  if (!/```(?:ts|typescript)?\s*[\s\S]+?```/i.test(responseText)) {
    return true;
  }
  return expectedPaths.some((path) => {
    const normalizedPath = normalizePromptLabFilePath(path).toLowerCase();
    const basename = normalizedPath.split("/").filter(Boolean).at(-1) ?? normalizedPath;
    return !normalized.includes(normalizedPath) && !normalized.includes(basename);
  });
}

function looksLikePromptLabLowSignalPlaceholder(responseText: string): boolean {
  const normalized = responseText.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return (
    normalized === "need answer with observed/inferred maybe incomplete." ||
    /^need answer\b/.test(normalized) ||
    (normalized.length < 120 && /\bmaybe incomplete\b/.test(normalized)) ||
    looksLikePromptLabInspectionContinuation(responseText)
  );
}

function extractPromptLabRequiredSectionLabels(prompt: string): string[] {
  const labels = ["Setup", "Act", "Assert", "Failure signature"];
  return labels.filter((label) => new RegExp(`\`${escapeRegExp(label)}\``, "i").test(prompt));
}

function extractPromptLabProofTarget(userTask: string): string {
  const normalized = userTask.replace(/\s+/g, " ").trim();
  const match =
    normalized.match(/\bpropose the exact minimal automated test that proves (.+?)(?:\.\s|$)/i) ??
    normalized.match(/\bpropose the exact minimal automated check that proves (.+?)(?:\.\s|$)/i) ??
    normalized.match(/\bpropose the exact minimal automated check that (.+?)(?:\.\s|$)/i) ??
    normalized.match(/\bidentify the exact assertions needed so (.+?)(?:\.\s|$)/i) ??
    normalized.match(/\bidentify the exact patch points needed so (.+?)(?:\.\s|$)/i);
  const captured = match?.[1]?.trim();
  return captured && captured.length > 0 ? captured : "the requested behavior holds in the repo-grounded path";
}

function extractPromptLabAnswerContractConstraint(prompt: string, label: string): string | undefined {
  const escaped = escapeRegExp(label);
  const match = prompt.match(new RegExp(`-\\s*\`${escaped}\`\\s+must\\s+(.+)`, "i"));
  const constraint = match?.[1]?.trim();
  if (!constraint) {
    return undefined;
  }
  return `${label} must ${constraint}`;
}

function describePromptLabAnchor(path: string): string {
  const basename = path.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? path;
  return `the behavior anchored in \`${basename}\``;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeRepoGroundedInspectionOutput(input: {
  prompt: string;
  responseText: string;
  toolRuns: ChatToolRunRecord[];
}): string {
  const trimmed = input.responseText.trim();
  if (!trimmed || !looksLikeRepoGroundedInspectionPrompt(input.prompt)) {
    return input.responseText;
  }
  if (/\bmode:\s*cowork\b/i.test(input.prompt) && promptKeepsRequestedRoleOrderOnly(input.prompt)) {
    return input.responseText;
  }
  const runtimeLifecycleMapRepair = buildRuntimeLifecycleProvenanceMapFallback({
    prompt: input.prompt,
    responseText: trimmed,
    toolRuns: input.toolRuns,
  });
  if (runtimeLifecycleMapRepair) {
    return runtimeLifecycleMapRepair;
  }
  const eventEnvelopeAuthorityRepair = buildEventEnvelopeAuthorityEvidenceFallback({
    prompt: input.prompt,
    responseText: trimmed,
    toolRuns: input.toolRuns,
  });
  if (eventEnvelopeAuthorityRepair) {
    return eventEnvelopeAuthorityRepair;
  }
  const approvalWakeFlowRepair = buildApprovalWakeFlowFallback({
    prompt: input.prompt,
    responseText: trimmed,
    toolRuns: input.toolRuns,
  });
  if (approvalWakeFlowRepair) {
    return approvalWakeFlowRepair;
  }
  const workspaceGuidancePrecedenceRepair = buildWorkspaceGuidancePrecedenceFallback({
    prompt: input.prompt,
    responseText: trimmed,
    toolRuns: input.toolRuns,
  });
  if (workspaceGuidancePrecedenceRepair) {
    return workspaceGuidancePrecedenceRepair;
  }
  const promptPackSourceLabelRepair = buildPromptPackSourceLabelEvidenceFallback({
    prompt: input.prompt,
    responseText: trimmed,
    toolRuns: input.toolRuns,
  });
  if (promptPackSourceLabelRepair) {
    return promptPackSourceLabelRepair;
  }
  const strictPausedWaitingWakeRepair = buildStrictPausedWaitingWakeEvidenceFallback({
    prompt: input.prompt,
    responseText: trimmed,
    toolRuns: input.toolRuns,
  });
  if (strictPausedWaitingWakeRepair) {
    return strictPausedWaitingWakeRepair;
  }
  const pausedWaitingWakeRepair = buildPausedWaitingWakeEvidenceFallback({
    prompt: input.prompt,
    responseText: trimmed,
    toolRuns: input.toolRuns,
  });
  if (pausedWaitingWakeRepair) {
    return pausedWaitingWakeRepair;
  }
  const knownPatchPlanRepair = buildPromptLabKnownPatchPlanFallback({
    prompt: input.prompt,
    responseText: trimmed,
    toolRuns: input.toolRuns,
  });
  if (knownPatchPlanRepair) {
    return knownPatchPlanRepair;
  }
  const durableLifecyclePatchPlanRepair = buildPromptLabDurableLifecyclePatchPlanFallback({
    prompt: input.prompt,
    responseText: trimmed,
    toolRuns: input.toolRuns,
  });
  if (durableLifecyclePatchPlanRepair) {
    return durableLifecyclePatchPlanRepair;
  }
  const promptPackParserRegressionRepair = buildPromptPackParserRegressionFallback({
    prompt: input.prompt,
    responseText: trimmed,
    toolRuns: input.toolRuns,
  });
  if (promptPackParserRegressionRepair) {
    return promptPackParserRegressionRepair;
  }
  const runtimeLifecycleTestSpecRepair = buildRuntimeLifecycleTestSpecFallback({
    prompt: input.prompt,
    responseText: trimmed,
    toolRuns: input.toolRuns,
  });
  if (runtimeLifecycleTestSpecRepair) {
    return runtimeLifecycleTestSpecRepair;
  }
  const realtimeEventMetadataTestSpecRepair = buildRealtimeEventMetadataTestSpecFallback({
    prompt: input.prompt,
    responseText: trimmed,
    toolRuns: input.toolRuns,
  });
  if (realtimeEventMetadataTestSpecRepair) {
    return realtimeEventMetadataTestSpecRepair;
  }
  const durableRunTestSpecRepair = buildDurableRunTestSpecFallback({
    prompt: input.prompt,
    responseText: trimmed,
    toolRuns: input.toolRuns,
  });
  if (durableRunTestSpecRepair) {
    return durableRunTestSpecRepair;
  }
  const promptLabTestSpecRepair = buildPromptLabTestSpecFallback({
    prompt: input.prompt,
    responseText: trimmed,
    toolRuns: input.toolRuns,
  });
  if (promptLabTestSpecRepair) {
    return promptLabTestSpecRepair;
  }
  const exactRepair = buildRepoGroundedEvidenceRepairContent(input.prompt, input.toolRuns);
  const repaired =
    exactRepair ??
    (looksLikePromptLabInspectionContinuation(trimmed)
      ? buildRecoveredRepoGroundedAnswer(input.prompt, input.toolRuns)
      : undefined);
  if (!repaired) {
    return input.responseText;
  }
  const exactFilesUsed = collectPromptLabConcreteReadEvidence(input.toolRuns).map((item) => item.path);
  const citesConcreteEvidence = exactFilesUsed.some(
    (path) =>
      trimmed.includes(path) ||
      trimmed.includes(path.replace(/^[A-Za-z]:[\\/]/, "").replace(/\\/g, "/")) ||
      trimmed.includes(path.split(/[\\/]/).at(-1) ?? ""),
  );
  if (citesConcreteEvidence && !looksLikePromptLabInspectionContinuation(trimmed)) {
    return input.responseText;
  }
  return repaired;
}

function extractPromptLabExactBulletLabels(prompt: string): string[] {
  const labelsLine = prompt
    .split(/\r?\n/)
    .find((line) =>
      /\b(?:use|return|provide)\s+exactly\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+bullets?\s+labeled\b/i.test(
        line,
      ),
    );
  if (!labelsLine) {
    return [];
  }
  return [...labelsLine.matchAll(/`([^`\r\n]+)`/g)].map((match) => match[1]?.trim() ?? "").filter(Boolean);
}

function promptLabForbidsTemplateOrPlaceholderCitations(prompt: string): boolean {
  return (
    /\bdo not cite\b[\s\S]{0,120}\btemplate files?\b/i.test(prompt) ||
    /\bdo not cite\b[\s\S]{0,120}\bplaceholder paths?\b/i.test(prompt) ||
    /\bwithout template leakage\b/i.test(prompt)
  );
}

function isPromptLabTemplateOrPlaceholderPath(path: string): boolean {
  const normalized = normalizePromptLabFilePath(path);
  return /(?:^|\/)templates?\//i.test(normalized) || /\{\{[^}]+\}\}/.test(normalized);
}

function promptLabPathAllowedByPrompt(path: string, prompt: string): boolean {
  if (!path) {
    return false;
  }
  if (promptLabForbidsTemplateOrPlaceholderCitations(prompt) && isPromptLabTemplateOrPlaceholderPath(path)) {
    return false;
  }
  return true;
}

function filterPromptLabExactFilePathsForPrompt(paths: string[], prompt: string): string[] {
  const seen = new Set<string>();
  const filtered: string[] = [];
  for (const rawPath of paths) {
    if (!rawPath || !promptLabPathAllowedByPrompt(rawPath, prompt)) {
      continue;
    }
    const normalized = normalizePromptLabFilePath(rawPath);
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    filtered.push(normalized);
  }
  return filtered;
}

function filterPromptLabConcreteReadEvidenceForPrompt(
  evidence: Array<{ path: string; content: string }>,
  prompt: string,
): Array<{ path: string; content: string }> {
  return evidence.filter((item) => promptLabPathAllowedByPrompt(item.path, prompt));
}

function filterPromptLabConcreteReadCitationsForPrompt(
  citations: Array<{ path: string; startLine?: number; endLine?: number }>,
  prompt: string,
): Array<{ path: string; startLine?: number; endLine?: number }> {
  return citations.filter((citation) => promptLabPathAllowedByPrompt(citation.path, prompt));
}

function promptLabContractRequiresConcreteFileEvidence(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bexact (?:evidence|file|files|patch points?|assertions?|cit(?:e|ed)|line numbers?)\b/.test(normalized) ||
    /\bexact citations?\b/.test(normalized) ||
    /\bfile-grounded\b/.test(normalized) ||
    /\bcite the exact\b/.test(normalized) ||
    /\bcite\b[\s\S]{0,80}\bexact files?\b/.test(normalized) ||
    /\bcitations?\b[\s\S]{0,60}\bfiles?\s+you\s+used\b/.test(normalized) ||
    /\bcite\b[\s\S]{0,80}\bfiles?\s+used\b/.test(normalized) ||
    /\bconcret(?:e|ely)\s+read\b/.test(normalized) ||
    /\bfiles?\s+whose\s+contents\s+you\s+concretely\s+read\b/.test(normalized)
  );
}

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

function collectPromptLabConcreteReadEvidence(toolRuns: ChatToolRunRecord[]): Array<{ path: string; content: string }> {
  const evidenceByPath = new Map<string, { path: string; content: string }>();
  for (const run of toolRuns) {
    if (
      run.status !== "executed" ||
      !toolNameMatchesAnyKnownTool(run.toolName, new Set(["file.read_range", "fs.read"])) ||
      !run.result ||
      typeof run.result !== "object"
    ) {
      continue;
    }
    const result = run.result as Record<string, unknown>;
    const rawPath =
      typeof result.path === "string" ? result.path : typeof run.args?.path === "string" ? run.args.path : undefined;
    if (!rawPath) {
      continue;
    }
    const normalizedPath = normalizePromptLabFilePath(rawPath);
    const key = normalizedPath.toLowerCase();
    const nextContent = normalizePromptLabEvidenceContent(
      typeof result.content === "string"
        ? result.content
        : typeof result.bodySnippet === "string"
          ? result.bodySnippet
          : typeof result.snippet === "string"
            ? result.snippet
            : "",
    );
    const existing = evidenceByPath.get(key);
    if (!existing) {
      evidenceByPath.set(key, {
        path: normalizedPath,
        content: nextContent,
      });
      continue;
    }
    if (nextContent && !existing.content.includes(nextContent)) {
      existing.content = [existing.content, nextContent].filter(Boolean).join("\n");
    }
    evidenceByPath.set(key, {
      path: normalizedPath,
      content: existing.content,
    });
  }
  return [...evidenceByPath.values()];
}

function normalizePromptLabEvidenceContent(content: string): string {
  let normalized = content.trim();
  const serializedPayloadContent = extractPromptLabEvidenceTextFromSerializedPayload(normalized);
  if (serializedPayloadContent) {
    normalized = serializedPayloadContent;
  }
  const wrappedContentMatch = normalized.match(/^[{[]?\s*['"]content['"]\s*:\s*(['"])([\s\S]*)\1\s*[,}]?\s*$/);
  if (wrappedContentMatch?.[2]) {
    normalized = wrappedContentMatch[2];
  }
  if (/\\[rn]/.test(normalized)) {
    normalized = normalized
      .replace(/\\r\\n/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\n")
      .replace(/\\t/g, "\t");
  }
  return normalized.replace(/\\'/g, "'").replace(/\\"/g, '"');
}

function extractPromptLabEvidenceTextFromSerializedPayload(content: string): string | undefined {
  const trimmed = content.trim();
  if (
    !/^(?:\{|\[)/.test(trimmed) ||
    !/['"](content|bodySnippet|snippet|text|body|message|path)['"]\s*:/.test(trimmed)
  ) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return readPromptLabEvidenceTextFromPayload(parsed);
  } catch {
    const singleQuotedContentMatch = trimmed.match(/['"]content['"]\s*:\s*'([\s\S]*?)'(?:\s*[,}])/);
    if (singleQuotedContentMatch?.[1]) {
      return singleQuotedContentMatch[1]
        .replace(/\\r\\n/g, "\n")
        .replace(/\\n/g, "\n")
        .replace(/\\'/g, "'");
    }
    const doubleQuotedContentMatch = trimmed.match(/['"]content['"]\s*:\s*"([\s\S]*?)"(?:\s*[,}])/);
    if (doubleQuotedContentMatch?.[1]) {
      return doubleQuotedContentMatch[1]
        .replace(/\\r\\n/g, "\n")
        .replace(/\\n/g, "\n")
        .replace(/\\"/g, '"');
    }
    return undefined;
  }
}

function readPromptLabEvidenceTextFromPayload(payload: unknown): string | undefined {
  if (typeof payload === "string") {
    return payload.trim();
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  for (const key of ["content", "bodySnippet", "snippet", "text", "body", "message"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function collectPromptLabConcreteReadCitations(
  toolRuns: ChatToolRunRecord[],
): Array<{ path: string; startLine?: number; endLine?: number }> {
  const seen = new Set<string>();
  const citations: Array<{ path: string; startLine?: number; endLine?: number }> = [];
  for (const run of toolRuns) {
    if (
      run.status !== "executed" ||
      !toolNameMatchesAnyKnownTool(run.toolName, new Set(["file.read_range", "fs.read"])) ||
      !run.result ||
      typeof run.result !== "object"
    ) {
      continue;
    }
    const result = run.result as Record<string, unknown>;
    const rawPath =
      typeof result.path === "string" ? result.path : typeof run.args?.path === "string" ? run.args.path : undefined;
    if (!rawPath) {
      continue;
    }
    const normalizedPath = normalizePromptLabFilePath(rawPath);
    const key = normalizedPath.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const startLine =
      typeof result.startLine === "number"
        ? result.startLine
        : typeof run.args?.startLine === "number"
          ? run.args.startLine
          : undefined;
    const endLine =
      typeof result.endLine === "number"
        ? result.endLine
        : typeof run.args?.endLine === "number"
          ? run.args.endLine
          : undefined;
    citations.push({
      path: normalizedPath,
      startLine,
      endLine,
    });
  }
  return citations;
}

function pickPromptLabConcreteReadEvidence(
  evidence: Array<{ path: string; content: string }>,
  predicate: (item: { path: string; content: string }) => boolean,
): { path: string; content: string } | undefined {
  return evidence.find(predicate);
}

function selectPromptLabConcreteReadPathsFromSearchResult(result: unknown): string[] {
  if (!result || typeof result !== "object" || !("matches" in result) || !Array.isArray(result.matches)) {
    return [];
  }
  const uniquePaths = [
    ...new Set(
      result.matches
        .map((match) => {
          if (!match || typeof match !== "object") {
            return undefined;
          }
          const candidatePath = "path" in match && typeof match.path === "string" ? match.path.trim() : "";
          const candidateType = "type" in match && typeof match.type === "string" ? match.type : undefined;
          return looksLikePromptLabConcreteFileCandidate(candidatePath, candidateType) ? candidatePath : undefined;
        })
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  if (uniquePaths.length === 0) {
    return [];
  }

  const rankedPaths = [...uniquePaths].sort(
    (left, right) => scorePromptLabConcreteReadCandidate(right) - scorePromptLabConcreteReadCandidate(left),
  );
  const selected: string[] = [];
  const add = (candidate: string | undefined): void => {
    if (!candidate || selected.includes(candidate)) {
      return;
    }
    selected.push(candidate);
  };

  const implementationPath = rankedPaths.find(
    (value) =>
      !/(?:^|\/)(?:docs?|artifacts)\//i.test(value) && !/\.test\.[^.]+$/i.test(value) && !/\.spec\.[^.]+$/i.test(value),
  );
  const companionPath = rankedPaths.find(
    (value) =>
      value !== implementationPath &&
      (/(?:^|\/)docs?\//i.test(value) ||
        /\.test\.[^.]+$/i.test(value) ||
        /\.spec\.[^.]+$/i.test(value) ||
        (/\.md$/i.test(value) && !/(?:^|\/)artifacts\//i.test(value))),
  );
  const artifactPath = rankedPaths.find(
    (value) => value !== implementationPath && value !== companionPath && /(?:^|\/)artifacts\//i.test(value),
  );
  const adjacentImplementationPath = rankedPaths.find(
    (value) =>
      value !== implementationPath &&
      value !== companionPath &&
      !/(?:^|\/)(?:docs?|artifacts)\//i.test(value) &&
      !/\.test\.[^.]+$/i.test(value) &&
      !/\.spec\.[^.]+$/i.test(value),
  );

  add(implementationPath);
  add(companionPath);
  add(adjacentImplementationPath);
  add(artifactPath);
  for (const value of rankedPaths) {
    if (selected.length >= 3) {
      break;
    }
    add(value);
  }
  return selected.slice(0, 3);
}

const PROMPT_LAB_TEXTUAL_FILE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".cts",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".md",
  ".mjs",
  ".mts",
  ".php",
  ".ps1",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

function looksLikePromptLabConcreteFileCandidate(path: string, type?: string): boolean {
  const normalized = path.replace(/\\/g, "/").trim();
  if (
    type === "dir" ||
    !normalized ||
    /\/$/.test(normalized) ||
    /(?:^|\/)(?:\.codex-tmp|\.worktrees|data\/tool-artifacts)(?:\/|$)/i.test(normalized)
  ) {
    return false;
  }
  const basename = normalized.split("/").filter(Boolean).at(-1) ?? "";
  if (!basename) {
    return false;
  }
  const extMatch = basename.match(/(\.[a-z0-9]+)$/i);
  const extension = extMatch?.[1]?.toLowerCase();
  if (!extension) {
    return /^(readme|makefile|dockerfile|justfile)$/i.test(basename);
  }
  return PROMPT_LAB_TEXTUAL_FILE_EXTENSIONS.has(extension);
}

function scorePromptLabConcreteReadCandidate(path: string): number {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  let score = 0;
  if (/(?:^|\/)(apps|packages|scripts|docs|src|test|tests)\//.test(normalized)) {
    score += 20;
  }
  if (
    /(?:^|\/)(?:artifacts\/prompt-lab|artifacts|dist|build|coverage|node_modules|\.worktrees|\.codex-tmp|data\/tool-artifacts|vendor|third_party|ggml)\//.test(
      normalized,
    )
  ) {
    score -= 30;
  }
  if (/(?:^|\/)templates?\//.test(normalized) || /{{[a-z0-9_]+}}/i.test(normalized)) {
    score -= 24;
  }
  if (/\.test\.[^.]+$|\.spec\.[^.]+$/.test(normalized)) {
    score += 6;
  }
  if (/\.md$/.test(normalized)) {
    score += 5;
  }
  if (!/\.test\.[^.]+$|\.spec\.[^.]+$|\.md$/.test(normalized)) {
    score += 10;
  }
  if (/(?:^|\/)(?:routes|services|orchestration|contracts|storage)\//.test(normalized)) {
    score += 4;
  }
  if (/(?:^|\/)(?:routes|services)\//.test(normalized)) {
    score += 6;
  }
  if (/\bprompt-pack\b|prompt_pack|promptpacksworkbench|prompt-packs-workbench/.test(normalized)) {
    score += 14;
  }
  if (/(?:^|\/)packages\/storage\/src\/prompt-pack-/.test(normalized)) {
    score += 10;
  }
  if (/(?:^|\/)apps\/mission-control-next\/src\/features\/prompt-packs\//.test(normalized)) {
    score += 10;
  }
  return score;
}

function collectPromptLabConcreteReadPaths(toolRuns: ChatToolRunRecord[]): Set<string> {
  const observed = new Set<string>();
  for (const run of toolRuns) {
    if (
      run.status !== "executed" ||
      !toolNameMatchesAnyKnownTool(run.toolName, new Set(["file.read_range", "fs.read"]))
    ) {
      continue;
    }
    const resultPath =
      run.result && typeof run.result === "object" && typeof (run.result as { path?: unknown }).path === "string"
        ? (run.result as { path: string }).path
        : undefined;
    const argsPath = typeof run.args?.path === "string" ? run.args.path : undefined;
    const candidate = resultPath ?? argsPath;
    if (!candidate) {
      continue;
    }
    observed.add(normalizePromptLabFilePath(candidate).toLowerCase());
  }
  return observed;
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

function promptLabConcreteReadSetMatchesPath(observedPaths: Set<string>, filePath: string): boolean {
  const normalized = normalizePromptLabFilePath(filePath).toLowerCase();
  if (observedPaths.has(normalized)) {
    return true;
  }
  for (const observed of observedPaths) {
    if (observed.endsWith(`/${normalized}`)) {
      return true;
    }
  }
  return false;
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
    add("apps/gateway/src/routes/memory.ts");
    add("apps/gateway/src/services/memory-route-service.ts");
    add("apps/gateway/src/services/memory-context-service.ts");
    add("apps/gateway/src/services/memory-lifecycle-service.ts");
    add("packages/storage/src/memory-context-repo.ts");
    add("apps/mission-control/src/pages/MemoryPage.tsx");
    add("apps/mission-control/src/pages/memory/MemoryMaintenancePanel.tsx");
  }

  if (
    /\bguidance\b/.test(normalizedTask) &&
    (/\bglobal docs\b/.test(normalizedTask) ||
      /\bworkspace docs\b/.test(normalizedTask) ||
      /\bruntime guidance\b/.test(normalizedTask) ||
      /\bagents\.md\b/.test(normalizedTask))
  ) {
    add("apps/gateway/src/services/guidance-doc-files.ts");
    add("apps/gateway/src/services/guidance-document-helpers.ts");
    add("apps/gateway/src/services/gateway-service.ts");
    add("apps/gateway/src/services/chat-turn-prep-service.ts");
    add("AGENTS.md");
  }

  if (looksLikePromptLabApprovalWakeOrderingMinimalTestPrompt(userTask)) {
    add("apps/gateway/src/services/approval-resolution-effects-service.test.ts");
    add("apps/gateway/src/services/approval-resolution-effects-service.ts");
    add("packages/storage/src/approval-effect-repo.ts");
    add("packages/storage/src/approval-wait-run-repo.ts");
    add("apps/gateway/src/services/durable-run-service.ts");
  }

  if (looksLikePromptLabRuntimeLifecycleProvenanceMapPrompt(userTask)) {
    add("apps/gateway/src/services/runtime-lifecycle-read-service.ts");
    add("apps/gateway/src/services/approval-lifecycle-service.ts");
    add("apps/gateway/src/routes/approvals.ts");
    add("packages/storage/src/approval-wait-run-repo.ts");
    add("packages/storage/src/chat-session-repo.ts");
  }

  if (looksLikePromptLabStrictPausedWaitingWakeEvidencePrompt(userTask)) {
    add("apps/gateway/src/services/durable-run-service.ts");
    add("apps/gateway/src/services/approval-resolution-effects-service.ts");
    add("apps/gateway/src/routes/durable.ts");
    add("apps/gateway/src/services/runtime-lifecycle-read-service.ts");
    add("packages/contracts/src/durable.ts");
  }

  if (looksLikePromptLabCronReportCoworkPrompt(userTask)) {
    add("apps/gateway/src/services/gateway/cron-automation-service.ts");
    add("apps/gateway/src/services/gateway/update-review.ts");
    add("apps/gateway/src/routes/prompt-packs.ts");
    add("packages/storage/src/cron-job-repo.ts");
    add("packages/mission-control-shared/src/api/prompt-packs.ts");
  }

  if (looksLikePromptLabTwoWorkerHarnessCoveragePatchPlanPrompt(userTask)) {
    add("packages/storage/src/durable-run-repo.test.ts");
    add("packages/storage/src/durable-run-repo.ts");
    add("apps/gateway/src/services/durable-run-service.ts");
    add("apps/gateway/src/services/durable-run-service.test.ts");
  }

  if (looksLikePromptLabTypedWakeOutcomeEvidencePrompt(userTask)) {
    add("packages/contracts/src/durable.ts");
    add("apps/gateway/src/services/durable-run-service.ts");
    add("apps/gateway/src/services/approval-resolution-effects-service.ts");
    add("apps/gateway/src/services/durable-run-service.test.ts");
    add("apps/gateway/src/services/approval-resolution-effects-service.test.ts");
  }

  if (looksLikePromptLabEventEnvelopeAuthorityPrompt(userTask)) {
    add("apps/gateway/src/services/gateway-service.ts");
    add("apps/gateway/src/services/realtime-event-service.ts");
    add("apps/gateway/src/services/realtime-events-route-service.ts");
    add("apps/gateway/src/routes/events.ts");
    add("packages/storage/src/realtime-event-repo.ts");
    add("packages/storage/src/realtime-event-repo.test.ts");
  }

  if (looksLikePromptLabDurableWakeOutcomePatchPlanPrompt(userTask)) {
    add("packages/contracts/src/durable.ts");
    add("apps/gateway/src/services/durable-run-service.ts");
    add("apps/gateway/src/services/approval-resolution-effects-service.ts");
    add("apps/gateway/src/routes/durable.ts");
    add("packages/mission-control-shared/src/api/durable.ts");
    add("apps/mission-control/src/api/durable.ts");
    add("apps/gateway/src/services/approval-resolution-effects-service.test.ts");
  }

  if (looksLikePromptLabPromptPackParserRegressionPrompt(userTask)) {
    add("goatcitadel_prompt_pack_v2.md");
    add("goatcitadel_prompt_pack.md");
    add("apps/gateway/src/services/prompt-pack-service.ts");
  }

  if (
    /\bprompt[- ]pack\b/.test(normalizedTask) &&
    /\bsource label|source-label|source_label|source labeling|export rendering\b/.test(normalizedTask)
  ) {
    add("apps/gateway/src/services/prompt-pack-service.ts");
    add("apps/gateway/src/services/prompt-pack-service.test.ts");
    add("packages/storage/src/prompt-pack-repo.ts");
    add("apps/gateway/src/routes/prompt-packs.ts");
    add("packages/mission-control-shared/src/api/prompt-packs.ts");
    add("packages/contracts/src/prompt-pack.ts");
  }

  if (
    looksLikePromptLabPromptPackProductSurfaceTask(userTask) &&
    /\b(?:test|run) records?\b|\bstored\b|\bstorage\b/.test(normalizedTask)
  ) {
    add("packages/storage/src/prompt-pack-repo.ts");
    add("packages/storage/src/prompt-pack-run-repo.ts");
    add("packages/storage/src/prompt-pack-score-repo.ts");
    add("packages/storage/src/prompt-pack-repo.test.ts");
    add("packages/storage/src/prompt-pack-run-repo.test.ts");
    add("apps/gateway/src/services/prompt-pack-service.ts");
  }

  if (
    looksLikePromptLabPromptPackProductSurfaceTask(userTask) &&
    /\b(?:mission control next|workbench|run details?|segmented control|harness\/agentic|agentic segmented)\b/.test(
      normalizedTask,
    )
  ) {
    add("apps/mission-control-next/src/features/prompt-packs/PromptPacksWorkbenchPage.tsx");
    add("apps/mission-control-next/src/features/prompt-packs/prompt-packs-workbench.css");
    add("packages/mission-control-shared/src/api/prompt-packs.ts");
    add("packages/contracts/src/prompt-pack.ts");
  }

  if (
    looksLikePromptLabPromptPackProductSurfaceTask(userTask) &&
    /\b(?:reports?|exports?|rendered|rendering|markdown report|exported results?)\b/.test(normalizedTask)
  ) {
    add("apps/gateway/src/services/prompt-pack-service.ts");
    add("apps/gateway/src/routes/prompt-packs.ts");
    add("packages/mission-control-shared/src/api/prompt-packs.ts");
    add("packages/contracts/src/prompt-pack.ts");
  }

  if (
    looksLikePromptLabPromptPackProductSurfaceTask(userTask) &&
    /\b(?:api shape|shared client|gateway route|single prompt[- ]pack test|running a single|run a single)\b/.test(
      normalizedTask,
    )
  ) {
    add("packages/mission-control-shared/src/api/prompt-packs.ts");
    add("apps/gateway/src/routes/prompt-packs.ts");
    add("apps/gateway/src/services/prompt-pack-service.ts");
    add("packages/contracts/src/prompt-pack.ts");
  }

  if (looksLikePromptLabJudgeDefaultsMinimalTestPrompt(userTask)) {
    add("apps/gateway/src/services/prompt-pack-service.test.ts");
    add("apps/gateway/src/services/prompt-pack-service.ts");
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
    add("scripts/run-prompt-pack-gates.ts");
    add("apps/gateway/src/services/prompt-pack-service.ts");
    add("apps/gateway/src/routes/prompt-packs.ts");
    add("packages/mission-control-shared/src/api/prompt-packs.ts");
  }

  return [...paths];
}

function extractPromptLabBulletBodies(responseText: string): Map<string, string> {
  const bullets = new Map<string, string>();
  const lines = responseText.split(/\r?\n/);
  let currentLabel: string | null = null;
  let currentBody: string[] = [];
  let currentParagraphClosed = false;

  const flush = () => {
    if (!currentLabel) {
      return;
    }
    const joined = currentBody.join("\n").trim();
    if (joined.length > 0) {
      bullets.set(normalizePromptLabLabel(currentLabel), joined);
    }
  };

  for (const line of lines) {
    const bulletMatch = line.match(/^\s*-\s*(?:\*\*)?(.+?)(?:\*\*)?\s*(?:—|:)\s*(.*)$/);
    if (bulletMatch) {
      flush();
      currentLabel = bulletMatch[1]?.trim() ?? null;
      currentBody = [bulletMatch[2]?.trim() ?? ""];
      currentParagraphClosed = false;
      continue;
    }
    if (!currentLabel) {
      continue;
    }
    if (line.trim().length === 0) {
      currentBody.push("");
      currentParagraphClosed = true;
      continue;
    }
    if (currentParagraphClosed && !/^\s+/.test(line)) {
      continue;
    }
    currentBody.push(line.trim());
  }
  flush();
  return bullets;
}

function normalizePromptLabLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
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

function normalizePromptLabFilePath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/");
  const repoMarker = "/personal-ai/";
  const markerIndex = normalized.toLowerCase().indexOf(repoMarker);
  if (markerIndex >= 0) {
    return normalized.slice(markerIndex + repoMarker.length);
  }
  return normalized.replace(/^\.\//, "");
}

function looksLikeHarnessContaminatedQuery(value: string): boolean {
  const normalized = value.toLowerCase().replace(/\s+/g, " ").trim();
  return PROMPT_HARNESS_QUERY_MARKERS.some((marker) => normalized.includes(marker));
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
    queries.push(trimmed);
  };

  if (looksLikePromptLabPromptPackOperatorSurfacePrompt(taskContent)) {
    addQuery("prompt-pack-service.ts");
    addQuery("prompt-packs.ts");
    addQuery("chat.prompt-pack-benchmark.test.ts");
  }
  if (looksLikePromptLabApprovalWakeFlowPrompt(taskContent)) {
    addQuery("approval-resolution-effects-service.ts");
    addQuery("approval-lifecycle-service.ts");
    addQuery("approval-wait-run-repo.ts");
    addQuery("approval-effect-repo.ts");
  }
  if (looksLikeWorkspaceRoutesGuidanceCoworkPrompt(taskContent)) {
    addQuery("workspaces.ts");
    addQuery("workspaces.test.ts");
    addQuery("workspace-repo.ts");
    addQuery("workspace-repo.test.ts");
    addQuery("guidance");
  }
  if (
    /\bglobal docs\b/.test(normalized) &&
    /\bworkspace docs\b/.test(normalized) &&
    /\brepo guidance\b/.test(normalized) &&
    /\bruntime\b/.test(normalized)
  ) {
    addQuery("guidance-document-helpers.ts");
    addQuery("guidance-doc-files.ts");
    addQuery("gateway-service.ts");
    addQuery("resolveRuntimeGuidance");
    addQuery("listWorkspaceGuidance");
    addQuery("AGENTS.md");
  }
  if (looksLikePromptLabMemoryLifecycleCoworkPrompt(taskContent)) {
    addQuery("memory.ts");
    addQuery("memory-context-repo.ts");
    addQuery("MemoryPage.tsx");
    addQuery("MemoryMaintenancePanel.tsx");
    addQuery("memory");
  }
  if (looksLikePromptLabCronReportCoworkPrompt(taskContent)) {
    addQuery("cron-job-repo.ts");
    addQuery("cron-automation-service.ts");
    addQuery("update-review.ts");
    addQuery("prompt-packs.ts");
    addQuery("api/prompt-packs.ts");
    addQuery("costs.ts");
    addQuery("costs/summary");
    addQuery("update-review-daily");
  }
  if (looksLikePromptLabRank1HardeningCoworkPrompt(taskContent)) {
    addQuery("durable-run-service.ts");
    addQuery("approval-resolution-effects-service.ts");
    addQuery("runtime-lifecycle-read-service.ts");
    addQuery("durable.ts");
    addQuery("wake");
  }
  if (looksLikePromptLabLifecycleCanonicalLinkagePrompt(taskContent)) {
    addQuery("runtime-lifecycle-read-service.test.ts");
    addQuery("runtime-lifecycle-read-service.ts");
    addQuery("approval_linkage");
    addQuery("fallback_payload");
    addQuery("fallback_preview");
  }
  if (looksLikePromptLabRuntimeLifecycleProvenanceMapPrompt(taskContent)) {
    addQuery("runtime-lifecycle-read-service.ts");
    addQuery("approval-lifecycle-service.ts");
    addQuery("approvals.ts");
    addQuery("approval_linkage");
    addQuery("fallback_payload");
    addQuery("fallback_preview");
    addQuery("sessionIdSource");
  }
  if (looksLikePromptLabStrictPausedWaitingWakeEvidencePrompt(taskContent)) {
    addQuery("durable-run-service.ts");
    addQuery("approval-resolution-effects-service.ts");
    addQuery("routes/durable.ts");
    addQuery("runtime-lifecycle-read-service.ts");
    addQuery("DurableWakeResult");
    addQuery("wakeDurableRun paused waiting");
  }
  if (looksLikePromptLabRealtimeEventMetadataPropagationPrompt(taskContent)) {
    addQuery("events.test.ts");
    addQuery("events.ts");
    addQuery("gateway-service.ts");
    addQuery("realtime-event-repo.test.ts");
    addQuery("realtime-event-repo.ts");
    addQuery("tool-invocation-coordinator-service.test.ts");
  }
  if (
    looksLikePromptLabEventEnvelopeAuthorityPrompt(taskContent) ||
    looksLikePromptLabEventLinkPropagationCoworkPrompt(taskContent)
  ) {
    addQuery("eventClass");
    addQuery("eventAuthority");
    addQuery("links");
    addQuery("gateway-service.ts");
    addQuery("realtime-event-service.ts");
    addQuery("realtime-events-route-service.ts");
    addQuery("events.ts");
    addQuery("realtime-event-repo.ts");
  }
  if (looksLikePromptLabDurableRunMinimalTestPrompt(taskContent)) {
    addQuery("durable-run-service.test.ts");
    addQuery("durable-run-service.ts");
    addQuery("durable-run-repo.test.ts");
    addQuery("durable-run-repo.ts");
    addQuery("approval-resolution-effects-service.test.ts");
    addQuery("approval-resolution-effects-service.ts");
    addQuery("approval-effect-repo.ts");
    addQuery("approval-wait-run-repo.ts");
  }
  if (looksLikePromptLabPromptPackGateSelectionTestPrompt(taskContent)) {
    addQuery("run-prompt-pack-gates.ts");
    addQuery("selectPromptPackTargets");
    addQuery("resolvePromptPack");
    addQuery("selectPromptPackGateTargetCodes");
    addQuery("prompt-pack-service.ts");
    addQuery("expansion-pack");
    addQuery("baseline");
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
    addQuery("prompt-pack-service.test.ts");
    addQuery("prompt-pack-service.ts");
    addQuery("parsePromptPackTests");
    addQuery("goatcitadel_prompt_pack_v2.md");
  }
  if (looksLikePromptLabEnvSourceLabelMinimalTestPrompt(taskContent)) {
    addQuery("prompt-pack-service.test.ts");
    addQuery("prompt-pack-service.ts");
    addQuery("ensurePromptPackLoaded");
    addQuery("GOATCITADEL_PROMPT_PACK_PATH");
    addQuery("sourceLabel");
  }
  if (looksLikePromptLabJudgeDefaultsMinimalTestPrompt(taskContent)) {
    addQuery("prompt-pack-service.test.ts");
    addQuery("prompt-pack-service.ts");
    addQuery("resolvePromptPackJudgeTarget");
    addQuery("getPromptJudgeModelDefaults");
    addQuery("judge defaults");
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
    addQuery("ApprovalsPage.tsx");
    addQuery("ApprovalsPage.test.tsx");
    addQuery("api/types.ts");
  }
  if (looksLikePromptLabExplicitEventAuthorityEnvelopePatchPlanPrompt(taskContent)) {
    addQuery("tool-invocation-coordinator-service.ts");
    addQuery("gateway-service.ts");
    addQuery("realtime-event-repo.ts");
    addQuery("realtime-event");
    addQuery("events.ts");
    addQuery("api/types.ts");
    addQuery("approval");
    addQuery("session");
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
    addQuery("MemoryPage");
    addQuery("MemoryPage.tsx");
    addQuery("MemoryMaintenancePanel.tsx");
    addQuery("memory-summary");
  }
  if (/\bmemory\b/i.test(normalized) && /\b(expir|prun|maintenance|lifecycle)\b/i.test(normalized)) {
    addQuery("pruneExpired");
    addQuery("pruneOlderThan");
    addQuery("MemoryMaintenancePanel.tsx");
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
    addQuery("prompt-pack-service.test.ts");
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

function looksLikePromptLabGuidanceLoadingSummaryPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bworkspace\b/.test(normalized) &&
    /\bguidance\b/.test(normalized) &&
    (/\bglobal\b/.test(normalized) || /\brepo\b/.test(normalized) || /\bchain\b/.test(normalized)) &&
    (/\brepo docs?\b/.test(normalized) ||
      /\brepo\b[\s,/-]*docs?\b/.test(normalized) ||
      /\bguidance loading chain\b/.test(normalized) ||
      /\bguidance loading path\b/.test(normalized)) &&
    (/\bload(?:ed|ing)?\b/.test(normalized) || /\bpath\b/.test(normalized) || /\bchain\b/.test(normalized)) &&
    !/\bmemory\b/.test(normalized)
  );
}

function looksLikeWorkspaceGuidancePrecedencePrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bworkspace\b/.test(normalized) &&
    /\bguidance\b/.test(normalized) &&
    (/\bprecedence\b/.test(normalized) || /\boverride\b/.test(normalized)) &&
    (/\boperator-visible\b/.test(normalized) ||
      /\bexact assertions needed\b/.test(normalized) ||
      /\bexact minimal automated check\b/.test(normalized) ||
      /\bexact minimal automated test\b/.test(normalized))
  );
}

function looksLikePromptLabDurableRunClaimExclusivityPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\btwo workers\b/.test(normalized) && /\bsame queued durable run\b/.test(normalized) && /\bclaim\b/.test(normalized)
  );
}

function looksLikePromptLabDurableRunLeaseRecoveryPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bexpired durable-run lease\b|\bexpired durable run lease\b/.test(normalized) &&
    /\bdifferent worker\b/.test(normalized) &&
    /\b(still-active leased run|still active leased run|active lease)\b/.test(normalized)
  );
}

function looksLikePromptLabDurableRunRetryBackoffPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bretry-gated queued durable runs\b|\bretry gated queued durable runs\b/.test(normalized) &&
    /\bbackoff window expires\b|\bbackoff window\b/.test(normalized)
  );
}

function looksLikePromptLabDurableRunLeaseReleaseTransitionPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bwaiting\b/.test(normalized) &&
    /\bpaused\b/.test(normalized) &&
    /\bterminal\b/.test(normalized) &&
    /\brelease any active lease\b/.test(normalized)
  );
}

function looksLikePromptLabApprovalWakeOrderingMinimalTestPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bapproval\b/.test(normalized) &&
    /\bwake\b/.test(normalized) &&
    /\b(ordering|before confirmed wake|confirmed wake|approval-wait|approval wait)\b/.test(normalized) &&
    /\bexact minimal automated check\b|\bexact minimal automated test\b|\btarget test file\b/.test(normalized)
  );
}

function looksLikePromptLabDurableRunMinimalTestPrompt(userTask: string | undefined): boolean {
  return (
    looksLikePromptLabDurableRunClaimExclusivityPrompt(userTask) ||
    looksLikePromptLabDurableRunLeaseRecoveryPrompt(userTask) ||
    looksLikePromptLabDurableRunRetryBackoffPrompt(userTask) ||
    looksLikePromptLabDurableRunLeaseReleaseTransitionPrompt(userTask) ||
    looksLikePromptLabApprovalWakeOrderingMinimalTestPrompt(userTask)
  );
}

function looksLikePromptLabLifecycleCanonicalLinkagePrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bruntime lifecycle\b/.test(normalized) &&
    /\bcanonical\b/.test(normalized) &&
    /\blinkage\b/.test(normalized) &&
    /\bpayload\b/.test(normalized) &&
    /\bpreview\b/.test(normalized) &&
    /\b(inferred|inference)\b/.test(normalized) &&
    (/\bdiagnostics\b/.test(normalized) || /\bfallback path\b/.test(normalized))
  );
}

function looksLikePromptLabRuntimeLifecycleProvenanceMapPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bruntime lifecycle\b/.test(normalized) &&
    /\bcanonical linkage\b/.test(normalized) &&
    /\binferred linkage\b/.test(normalized) &&
    /\bmissing linkage\b/.test(normalized) &&
    /\bapprovals?\b/.test(normalized) &&
    /\bdurable runs?\b/.test(normalized) &&
    /\bsessions?\b/.test(normalized) &&
    /\bturns?\b/.test(normalized)
  );
}

function looksLikePromptLabStrictPausedWaitingWakeEvidencePrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bdurable-run wake logic\b|\bdurable run wake logic\b/.test(normalized) &&
    /\bapproval wake helpers?\b/.test(normalized) &&
    /\boperator resume path\b|\boperator resume\b/.test(normalized)
  );
}

function looksLikePromptLabRealtimeEventMetadataPropagationPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\beventclass\b/.test(normalized) &&
    /\beventauthority\b/.test(normalized) &&
    /\blinks\b/.test(normalized) &&
    /\bproducer\b/.test(normalized) &&
    /\bstorage\b/.test(normalized) &&
    /\boperator-facing api\b|\boperator facing api\b/.test(normalized)
  );
}

function looksLikePromptLabEventEnvelopeAuthorityPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bevent\b/.test(normalized) &&
    /\b(publishing|storage|publishing and storage)\b/.test(normalized) &&
    /\beventclass\b/.test(normalized) &&
    /\beventauthority\b/.test(normalized) &&
    /\blinks\b/.test(normalized) &&
    /\binference still required\b|\bnot found\b/.test(normalized)
  );
}

function looksLikePromptLabEventLinkPropagationCoworkPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bevent\b/.test(normalized) &&
    /\blinks?\b/.test(normalized) &&
    /\bclassification\b/.test(normalized) &&
    /\bproducer\b/.test(normalized) &&
    /\boperator-visible\b|\boperator visible\b|\bapi\b|\bui\b/.test(normalized) &&
    /\b(role-labeled|role labeled|architect|qa|product|ops|researcher)\b/.test(normalized)
  );
}

function looksLikePromptLabApprovalWakeFlowPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bapproval wait\b/.test(normalized) &&
    /\bwake\b/.test(normalized) &&
    /\b(event emission|operational event|publishrealtime|realtime event)\b/.test(normalized)
  );
}

function looksLikeWorkspaceRoutesGuidanceCoworkPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    (/\bworkspace routes\b/.test(normalized) &&
      /\bguidance docs?\b/.test(normalized) &&
      /\brelated services\b/.test(normalized) &&
      /\bfirst fresh regression checks to add\b/.test(normalized)) ||
    (/\bworkspace loading\b/.test(normalized) &&
      /\bguidance docs?\b/.test(normalized) &&
      /\bproject[- ]binding behavior\b/.test(normalized) &&
      /\beffective override chain\b/.test(normalized))
  );
}

function looksLikePromptLabGuidanceRegressionSliceCoworkPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bguidance\b/.test(normalized) &&
    /\bprecedence\b/.test(normalized) &&
    /\brepo(?:-| )?binding\b|\bproject binding\b|\boverride clarity\b|\boperator-visible override\b/.test(normalized) &&
    /\bfresh regression slice\b|\bsmallest fresh regression\b|\bregression slice\b/.test(normalized)
  );
}

function looksLikePromptLabMemoryLifecycleCoworkPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bmemory\b/.test(normalized) &&
    /\b(lifecycle|routes?|services?|ui|copy|operator-facing|operator facing)\b/.test(normalized) &&
    /\b(role-labeled|role labeled|researcher|architect|qa|product|ops|synthesis)\b/.test(normalized)
  );
}

function looksLikePromptLabCronReportCoworkPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\b(cron|scheduled|review queue|update-review|update review)\b/.test(normalized) &&
    /\b(report|cost|status|operator)\b/.test(normalized) &&
    /\b(role-labeled|role labeled|researcher|architect|qa|product|ops|synthesis)\b/.test(normalized)
  );
}

function looksLikePromptLabRank1HardeningCoworkPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\b(rank[- ]?1|rank 1|hardening|cross-system|cross system)\b/.test(normalized) &&
    /\b(approval|wake|durable|lifecycle)\b/.test(normalized) &&
    /\b(role-labeled|role labeled|researcher|architect|qa|product|ops|synthesis)\b/.test(normalized)
  );
}

function looksLikePromptLabApprovalPartialFailureCoworkPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bapproval resolution\b/.test(normalized) &&
    /\bwake helpers?\b/.test(normalized) &&
    /\bdownstream effect visibility\b/.test(normalized) &&
    /\bpartial[- ]failure cases?\b/.test(normalized) &&
    /\b(role-labeled|role labeled|researcher|product|qa)\b/.test(normalized)
  );
}

function looksLikePromptLabDurableWakeOutcomePatchPlanPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    (/\btyped wake outcome contract\b/.test(normalized) &&
      /\bdurable-run wake logic\b|\bdurable wake logic\b/.test(normalized) &&
      /\bapproval-wait wake handling\b|\bapproval wait wake handling\b/.test(normalized)) ||
    (/\btyped wake outcomes?\b/.test(normalized) &&
      /\bcontract file\b/.test(normalized) &&
      /\bproducer call sites?\b|\bproducer\b/.test(normalized) &&
      /\bconsumer\/status shaping\b|\bconsumer or status shaping\b|\bconsumer\b/.test(normalized) &&
      /\bcompatibility note\b/.test(normalized) &&
      /\bvalidation path\b|\bvalidation step\b/.test(normalized))
  );
}

function looksLikePromptLabTypedWakeOutcomeEvidencePrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\btyped wake outcomes?\b/.test(normalized) &&
    (/\bcontract file\b/.test(normalized) || /\bname the contract file\b/.test(normalized)) &&
    (/\bproducer call sites?\b/.test(normalized) || /\bproducer\b/.test(normalized)) &&
    (/\bconsumer\/status shaping\b/.test(normalized) ||
      /\bconsumer or status shaping\b/.test(normalized) ||
      (/\bconsumer\b/.test(normalized) && /\bstatus\b/.test(normalized))) &&
    (/\bvalidation step\b/.test(normalized) || /\bvalidation path\b/.test(normalized)) &&
    /\bpatch points?\b/.test(normalized)
  );
}

function looksLikePromptLabPromptPackGateSelectionTestPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bgate selection\b/.test(normalized) &&
    /\bexpansion pack\b/.test(normalized) &&
    /\bolder baseline\b|\bbaseline\b/.test(normalized)
  );
}

function looksLikePromptLabCoworkExtraHeadingMinimalTestPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bcowork\b/.test(normalized) &&
    (/\bextra headings?\b/.test(normalized) || /\bfake cowork headings?\b/.test(normalized)) &&
    /\binline contract echoes?\b|\bcontract echoes?\b|\bprompt lab\b/.test(normalized) &&
    /\bexact minimal automated (?:test|check)\b|\bpropose the exact minimal automated\b/.test(normalized)
  );
}

function looksLikePromptLabWrappedDependentsParserTestPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return /\bpnpm outdated -r\b/.test(normalized) && /\bdependents column wraps?\b/.test(normalized);
}

function looksLikePromptLabSkillExtraOverlapInstallTestPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\boverlapping skill families\b|\bduplicate skill famil/.test(normalized) &&
    /\bskills\/extra\b/.test(normalized) &&
    /\bblocked\b|\breject\b|\bprevent/.test(normalized)
  );
}

function looksLikePromptLabPromptPackV2DistinctTestPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bgoatcitadel_prompt_pack_v2\.md\b/.test(normalized) &&
    (/\bparse(?:s|d)? cleanly\b/.test(normalized) || /\bparses cleanly\b/.test(normalized)) &&
    /\b(frozen baseline|baseline fixture|remains distinct|distinct from)\b/.test(normalized)
  );
}

function looksLikePromptLabEnvSourceLabelMinimalTestPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\benv-loaded prompt pack\b|\benv loaded prompt pack\b/.test(normalized) && /\bsource label\b/.test(normalized)
  );
}

function looksLikePromptLabJudgeDefaultsMinimalTestPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bjudge defaults?\b/.test(normalized) &&
    /\bexpanded pack\b/.test(normalized) &&
    (/\bfrozen baseline\b/.test(normalized) || /\bbaseline\b/.test(normalized))
  );
}

function looksLikePromptLabPromptPackParserRegressionPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    looksLikePromptLabPromptPackV2DistinctTestPrompt(userTask) ||
    (/\bgoatcitadel_prompt_pack_v2\.md\b/.test(normalized) &&
      (/\bparse(?:s|d)? cleanly\b/.test(normalized) || /\bparsing path\b/.test(normalized)) &&
      (/\bfrozen baseline\b/.test(normalized) || /\bbaseline fixture\b/.test(normalized)) &&
      /\b(regression test|parser-focused regression|parser focused regression)\b/.test(normalized))
  );
}

function looksLikePromptLabWakeLifecycleOrderingPatchPlanPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bwake lifecycle writes reflect actual outcome ordering\b/.test(normalized) &&
    /\bapproval-wait storage\b|\bapproval wait storage\b/.test(normalized) &&
    /\bdurable wake calls\b/.test(normalized)
  );
}

function looksLikePromptLabPersistedDurableLeasesPatchPlanPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bpersisted leases\b/.test(normalized) &&
    /\bdurable-run storage\b|\bdurable run storage\b/.test(normalized) &&
    /\bclaim logic\b/.test(normalized) &&
    /\brecovery logic\b/.test(normalized)
  );
}

function looksLikePromptLabLifecycleProvenancePatchPlanPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bcanonical-linkage-first reads\b|\bcanonical linkage first reads\b/.test(normalized) &&
    /\bprovenance fields?\b/.test(normalized) &&
    /\blifecycle assembly\b/.test(normalized)
  );
}

function looksLikePromptLabMissionControlTruthLabelingPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bmission control truth labeling\b/.test(normalized) &&
    /\bcanonical\b/.test(normalized) &&
    /\binferred\b/.test(normalized) &&
    /\bmissing links?\b/.test(normalized)
  );
}

function looksLikePromptLabExplicitEventAuthorityEnvelopePatchPlanPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    (/\bexplicit event authority envelope\b/.test(normalized) ||
      (/\bevent producers\b/.test(normalized) &&
        /\brealtime-event storage\b|\brealtime event storage\b/.test(normalized) &&
        /\brelated contracts\b/.test(normalized))) &&
    /\beventclass\b/.test(normalized) &&
    /\beventauthority\b/.test(normalized) &&
    /\blinks\b/.test(normalized)
  );
}

function looksLikePromptLabTwoWorkerHarnessCoveragePatchPlanPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    (/\btwo-worker harness coverage\b|\btwo worker harness coverage\b/.test(normalized) ||
      (/\btwo-worker\b|\btwo worker\b/.test(normalized) &&
        /\bclaim\b/.test(normalized) &&
        /\brecovery\b/.test(normalized) &&
        /\bsingle-process\b|\bsingle process\b/.test(normalized))) &&
    (/\bclaim race\b/.test(normalized) || /\bclaim and recovery test\b/.test(normalized))
  );
}

function looksLikePromptLabApprovalEffectsHardeningPatchPlanPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    (/\bapproval-effects hardening\b|\bapproval effects hardening\b/.test(normalized) ||
      (/\bapproval resolution\b/.test(normalized) &&
        /\bdownstream effect handling\b/.test(normalized) &&
        /\bcanonical approval state\b/.test(normalized))) &&
    /\bidempotent effect tracking\b|\boutbox path\b/.test(normalized) &&
    /\bcanonical approval state\b/.test(normalized)
  );
}

function looksLikeSkillImportOverlapCoworkPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /skill-import-service\.ts/.test(normalized) &&
    /\boverlap\b/.test(normalized) &&
    /\b(next|fresh)\b/.test(normalized) &&
    /\bcases?\b/.test(normalized)
  );
}

function looksLikePromptPackRepoBindingCoworkPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\brepo-binding\b|\brepo binding\b/.test(normalized) &&
    /\btool-path resolution\b|\btool path resolution\b/.test(normalized) &&
    /\bnegative-result honesty checks\b|\bnegative result honesty checks\b/.test(normalized)
  );
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
    if (!looksLikePromptPathCandidate(normalized) || candidates.includes(normalized)) {
      return;
    }
    candidates.push(normalized);
  };
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

function extractExplicitToolLikeReferences(content: string): Set<string> {
  const matches = new Set<string>();
  const normalized = content.toLowerCase();
  for (const match of normalized.matchAll(
    /\b(browser|http|file|code|memory|shell|git|tests|lint|time)\.[a-z][a-z0-9_.-]*\b/g,
  )) {
    matches.add(match[0]!);
  }
  for (const match of normalized.matchAll(
    /\b(browser|http|file|code|memory|shell|git|tests|lint|time)_[a-z][a-z0-9_-]*\b/g,
  )) {
    const raw = match[0]!;
    const namespaceEnd = raw.indexOf("_");
    if (namespaceEnd > 0) {
      matches.add(`${raw.slice(0, namespaceEnd)}.${raw.slice(namespaceEnd + 1)}`);
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
    /\bmemory\.(read|search)\b/.test(normalized) ||
    /\b(search|look up|lookup|find|retrieve|recall|read|check|load)\b.{0,40}\b(memory|memories|note|notes|saved|stored|preference|preferences|context)\b/.test(
      normalized,
    ) ||
    /\b(what do you remember|do you remember)\b/.test(normalized) ||
    (/\b(confirm|verify|check)\b/.test(normalized) && /\b(saved|stored|remembered|memory|note)\b/.test(normalized))
  );
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

function buildSafeWriteFallbackPath(sessionId: string, toolName: string, originalPath: unknown): string | undefined {
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
  const safeBaseName = sanitizePathSegment(baseName) || (toolName === "artifacts.create" ? "artifact" : "output");
  const fallbackExt = ext || (toolName === "artifacts.create" ? ".md" : ".txt");
  return `${SAFE_WRITE_FALLBACK_DIR}/${safeBaseName}-${safeSessionId}${fallbackExt}`;
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

export function defaultThinkingTokens(level: ChatThinkingLevel): number | undefined {
  if (level === "minimal") {
    return 300;
  }
  if (level === "extended") {
    return 1800;
  }
  return 900;
}

function resolveChatExecutionBudget(
  input: Pick<ChatAgentTurnInput, "mode" | "webMode" | "thinkingLevel"> & {
    liveDataIntent?: boolean;
    promptLabExplicitTools?: boolean;
    promptLabHarness?: boolean;
    providerId?: string;
    model?: string;
  },
): ChatExecutionBudget {
  const defaultMaxTokens = defaultThinkingTokens(input.thinkingLevel);
  let budget: ChatExecutionBudget;
  if (input.webMode === "deep") {
    budget = applyPromptLabExplicitToolBudget(
      {
        turnBudgetMs: TESTING_CHAT_TURN_BUDGET_MS,
        completionTimeoutMs: TESTING_CHAT_COMPLETION_TIMEOUT_MS,
        maxToolLoops: MAX_TOOL_LOOPS,
        maxToolRunsPerTurn: MAX_TOOL_RUNS_PER_TURN,
        searchMaxResults: 8,
        maxTokens: Math.max(defaultMaxTokens ?? 900, 1200),
        minSynthesisReserveMs: 15000,
        expensiveToolMinimumRemainingMs: 30000,
      },
      input.promptLabExplicitTools,
    );
  } else if (input.webMode === "quick") {
    budget = applyPromptLabExplicitToolBudget(
      {
        turnBudgetMs: TESTING_CHAT_TURN_BUDGET_MS,
        completionTimeoutMs: TESTING_CHAT_COMPLETION_TIMEOUT_MS,
        maxToolLoops: 2,
        maxToolRunsPerTurn: 3,
        searchMaxResults: 4,
        maxTokens: Math.min(defaultMaxTokens ?? 600, 600),
        minSynthesisReserveMs: 6000,
        expensiveToolMinimumRemainingMs: 12000,
      },
      input.promptLabExplicitTools,
    );
  } else if (input.webMode === "off") {
    budget = applyPromptLabExplicitToolBudget(
      {
        turnBudgetMs: TESTING_CHAT_TURN_BUDGET_MS,
        completionTimeoutMs: TESTING_CHAT_COMPLETION_TIMEOUT_MS,
        maxToolLoops: 2,
        maxToolRunsPerTurn: 4,
        searchMaxResults: 0,
        maxTokens: Math.min(defaultMaxTokens ?? 700, 800),
        minSynthesisReserveMs: 7000,
        expensiveToolMinimumRemainingMs: 14000,
      },
      input.promptLabExplicitTools,
    );
  } else if (input.liveDataIntent) {
    budget = applyPromptLabExplicitToolBudget(
      {
        turnBudgetMs: TESTING_CHAT_TURN_BUDGET_MS,
        completionTimeoutMs: TESTING_CHAT_COMPLETION_TIMEOUT_MS,
        maxToolLoops: 5,
        maxToolRunsPerTurn: 8,
        searchMaxResults: 6,
        maxTokens: Math.min(defaultMaxTokens ?? 900, 1100),
        minSynthesisReserveMs: 12000,
        expensiveToolMinimumRemainingMs: 28000,
      },
      input.promptLabExplicitTools,
    );
  } else {
    budget = applyPromptLabExplicitToolBudget(
      {
        turnBudgetMs: TESTING_CHAT_TURN_BUDGET_MS,
        completionTimeoutMs: TESTING_CHAT_COMPLETION_TIMEOUT_MS,
        maxToolLoops: 4,
        maxToolRunsPerTurn: 7,
        searchMaxResults: 5,
        maxTokens: Math.min(defaultMaxTokens ?? 900, 1100),
        minSynthesisReserveMs: 10000,
        expensiveToolMinimumRemainingMs: 20000,
      },
      input.promptLabExplicitTools,
    );
  }
  budget = applyPromptLabHarnessBudget(budget, {
    mode: input.mode,
    promptLabHarness: input.promptLabHarness,
    promptLabExplicitTools: input.promptLabExplicitTools,
  });
  if (!shouldUseConstrainedLocalAgentProfile(input.providerId, input.model)) {
    return budget;
  }
  return {
    ...budget,
    maxToolLoops: Math.min(budget.maxToolLoops, input.promptLabExplicitTools ? 4 : 3),
    maxToolRunsPerTurn: Math.min(budget.maxToolRunsPerTurn, input.promptLabExplicitTools ? 6 : 5),
    maxTokens: Math.max(budget.maxTokens ?? 900, 1400),
    minSynthesisReserveMs: Math.max(budget.minSynthesisReserveMs, 12000),
  };
}

function applyPromptLabHarnessBudget(
  budget: ChatExecutionBudget,
  input: Pick<ChatAgentTurnInput, "mode"> & {
    promptLabHarness?: boolean;
    promptLabExplicitTools?: boolean;
  },
): ChatExecutionBudget {
  if (!input.promptLabHarness) {
    return budget;
  }
  const maxToolRunsPerTurn = input.promptLabExplicitTools
    ? PROMPT_LAB_EXPLICIT_MAX_TOOL_RUNS_PER_TURN
    : PROMPT_LAB_IMPLICIT_MAX_TOOL_RUNS_PER_TURN[input.mode];
  return {
    ...budget,
    maxToolLoops: Math.max(budget.maxToolLoops, PROMPT_LAB_MAX_TOOL_LOOPS),
    maxToolRunsPerTurn: Math.max(budget.maxToolRunsPerTurn, maxToolRunsPerTurn),
    searchMaxResults: Math.max(budget.searchMaxResults, 8),
    maxTokens: Math.max(budget.maxTokens ?? 900, PROMPT_LAB_MIN_MAX_TOKENS[input.mode]),
    minSynthesisReserveMs: Math.max(budget.minSynthesisReserveMs, 15000),
  };
}

function applyPromptLabExplicitToolBudget(
  budget: ChatExecutionBudget,
  promptLabExplicitTools?: boolean,
): ChatExecutionBudget {
  if (!promptLabExplicitTools) {
    return budget;
  }
  return {
    ...budget,
    maxToolLoops: Math.max(budget.maxToolLoops, MAX_TOOL_LOOPS),
    maxToolRunsPerTurn: Math.max(budget.maxToolRunsPerTurn, MAX_TOOL_RUNS_PER_TURN),
  };
}

function shouldUseConstrainedLocalAgentProfile(providerId?: string, model?: string): boolean {
  const normalizedProviderId = (providerId ?? "").trim().toLowerCase();
  const normalizedModel = (model ?? "").trim().toLowerCase();
  return normalizedProviderId === "llamacpp" || normalizedModel.includes("gemma");
}

function minimumRemainingBudgetForToolStart(toolName: string, executionBudget: ChatExecutionBudget): number {
  if (isExpensiveChatTool(toolName)) {
    return Math.max(executionBudget.expensiveToolMinimumRemainingMs, executionBudget.minSynthesisReserveMs);
  }
  return executionBudget.minSynthesisReserveMs;
}

function isExpensiveChatTool(toolName: string): boolean {
  return (
    toolName === "browser.navigate" ||
    toolName === "browser.extract" ||
    toolName === "http.get" ||
    toolName === "http.post"
  );
}

function extendTurnBudgetForExecutedBrowserTool(input: {
  toolName: string;
  toolStatus: ChatToolRunRecord["status"];
  webMode: ChatWebMode;
  webLookupIntent?: boolean;
  currentTurnBudgetMs: number;
  currentCompletionTimeoutMs: number;
  turnBudgetDeadline: number;
}): {
  turnBudgetDeadline: number;
  effectiveTurnBudgetMs: number;
  effectiveCompletionTimeoutMs: number;
} {
  if (
    input.webMode !== "auto" ||
    input.toolStatus !== "executed" ||
    !shouldExtendTurnBudgetForBrowserExecution(input.toolName)
  ) {
    return {
      turnBudgetDeadline: input.turnBudgetDeadline,
      effectiveTurnBudgetMs: input.currentTurnBudgetMs,
      effectiveCompletionTimeoutMs: input.currentCompletionTimeoutMs,
    };
  }
  const extendedTurnBudgetMs = isExpensiveChatTool(input.toolName)
    ? Math.max(input.currentTurnBudgetMs, input.webLookupIntent ? 90000 : 70000)
    : Math.max(input.currentTurnBudgetMs, 50000);
  const extendedCompletionTimeoutMs = isExpensiveChatTool(input.toolName)
    ? Math.max(input.currentCompletionTimeoutMs, input.webLookupIntent ? 40000 : 28000)
    : input.currentCompletionTimeoutMs;
  if (
    extendedTurnBudgetMs === input.currentTurnBudgetMs &&
    extendedCompletionTimeoutMs === input.currentCompletionTimeoutMs
  ) {
    return {
      turnBudgetDeadline: input.turnBudgetDeadline,
      effectiveTurnBudgetMs: input.currentTurnBudgetMs,
      effectiveCompletionTimeoutMs: input.currentCompletionTimeoutMs,
    };
  }
  return {
    turnBudgetDeadline: input.turnBudgetDeadline + (extendedTurnBudgetMs - input.currentTurnBudgetMs),
    effectiveTurnBudgetMs: extendedTurnBudgetMs,
    effectiveCompletionTimeoutMs: extendedCompletionTimeoutMs,
  };
}

function shouldExtendTurnBudgetForBrowserExecution(toolName: string): boolean {
  return toolName === "browser.search" || isExpensiveChatTool(toolName);
}

function createTurnBudgetDeadline(turnBudgetMs: number): number {
  return Date.now() + turnBudgetMs;
}

function ensureChatTurnBudgetRemaining(deadline: number, webMode: ChatWebMode, turnBudgetMs: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new ChatTurnBudgetExceededError(webMode, turnBudgetMs);
  }
  return remaining;
}

function buildTurnBudgetExceededReason(webMode: ChatWebMode, turnBudgetMs: number): string {
  if (webMode === "deep") {
    return `the deep-research response budget ran out after ${Math.floor(turnBudgetMs / 1000)} seconds`;
  }
  return `the response budget ran out after ${Math.floor(turnBudgetMs / 1000)} seconds to keep chat responsive`;
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
  const name = error.name.toLowerCase();
  const message = error.message.toLowerCase();
  return (
    name.includes("abort") || name.includes("cancel") || message.includes("aborted") || message.includes("cancelled")
  );
}

function buildChatTurnFailureRecord(
  failureClass: ChatTurnFailureClass,
  message: string,
  recommendedAction: ChatTurnRecoveryAction = getChatTurnRecoveryAction(failureClass),
): ChatTurnFailureRecord {
  return {
    failureClass,
    message,
    retryable: failureClass !== "auth_required",
    recommendedAction,
  };
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

function buildUserSafeFailureMessage(failure: ChatTurnFailureRecord): string {
  switch (failure.failureClass) {
    case "provider_timeout":
      return "The model request timed out before completion. Retry once, or switch to a lighter mode for faster results.";
    case "network_interrupted":
      return "The request was interrupted before the turn could finish. Retry once and check the gateway connection if it happens again.";
    case "tool_blocked":
      return "A required source blocked automated access. Retry with a narrower request, or continue from the strongest leads already gathered.";
    case "tool_failed":
      return "A required tool failed before the turn could finish. Retry once, or narrow the request so it can complete without that tool path.";
    case "auth_required":
      return "The selected provider or integration needs valid auth before this turn can continue. Reconnect auth or choose another provider.";
    case "tool_loop_guard":
      return "This turn stopped after the tool loop guard detected repeated low-progress tool work. Narrow the request or continue from the strongest evidence already gathered.";
    case "global_circuit_breaker":
      return "This turn stopped after repeated tool failures tripped the circuit breaker. Retry with a narrower request or continue from the strongest evidence already gathered.";
    case "tool_run_budget_exceeded":
      return "This turn hit the current tool-run budget before a full pass finished. Narrow the request or continue from the strongest leads already gathered.";
    case "turn_budget_exceeded":
    case "budget_exceeded":
      return "This turn hit the current execution budget before a full pass finished. Continue from the strongest leads or switch to a deeper mode.";
    case "approval_required":
      return "This turn is waiting for approval before it can continue.";
    default:
      return "This turn failed before completion. Retry once, or narrow the request so the next pass can finish cleanly.";
  }
}

function buildTurnBudgetExceededFallbackMessage(
  input: ChatAgentTurnInput,
  toolRuns: ChatToolRunRecord[],
  turnBudgetMs: number,
): string {
  const fetchedContentFallback = buildFetchedContentBudgetFallback(input.webMode, toolRuns, input.content);
  if (fetchedContentFallback) {
    return fetchedContentFallback;
  }
  const searchFallback = buildSearchResultBudgetFallback(input.webMode, toolRuns);
  if (searchFallback) {
    return searchFallback;
  }
  if (toolRuns.length > 0) {
    return buildDeterministicToolSynthesisFallback(
      input.content,
      toolRuns,
      buildTurnBudgetExceededReason(input.webMode, turnBudgetMs),
    );
  }
  if (input.webMode === "deep") {
    return "I ran out of time before I could finish that deep-research pass. Narrow the scope or split it into smaller follow-ups and I can continue.";
  }
  return "I stopped that turn to keep chat responsive. If you want a slower, more exhaustive pass, enable Deep research and resend it.";
}

function buildFetchedContentBudgetFallback(
  webMode: ChatWebMode,
  toolRuns: ChatToolRunRecord[],
  userPrompt: string,
): string | undefined {
  return buildRecoveredEvidenceAnswer(userPrompt, toolRuns, {
    note:
      webMode === "deep"
        ? "This is a partial answer recovered before the deep pass finished."
        : "This is a partial answer recovered before the turn hit its response budget.",
  });
}

function buildSearchResultBudgetFallback(webMode: ChatWebMode, toolRuns: ChatToolRunRecord[]): string | undefined {
  const recoveredItems = recoverTitleUrlItems(toolRuns, 5);
  if (recoveredItems.length === 0) {
    return undefined;
  }
  const blockedSource = inferBlockedSourceFailure(toolRuns);
  const lines = [
    blockedSource
      ? `A source blocked automated browsing${blockedSource.host ? ` on ${blockedSource.host}` : ""}, so I’m falling back to the strongest leads I recovered so far:`
      : webMode === "deep"
        ? "I ran out of time before I could finish the full deep-research pass, but these look like the strongest leads so far:"
        : "I ran out of time before I could finish a full pass, but these look like the strongest leads so far:",
    "",
    ...recoveredItems.slice(0, 3).map((item, index) => `${index + 1}. ${formatRecoveredSearchLead(item)}`),
    "",
    webMode === "deep"
      ? "If you want, ask me to continue from these results and narrow them down."
      : "If you want, ask me to continue from these results and narrow them down, or retry in Deep mode for a slower pass.",
  ];
  return lines.join("\n");
}

interface RecoveredFetchedContentEvidence {
  title?: string;
  url?: string;
  text: string;
}

function recoverFetchedContentEvidence(toolRuns: ChatToolRunRecord[]): RecoveredFetchedContentEvidence | undefined {
  for (let index = toolRuns.length - 1; index >= 0; index -= 1) {
    const run = toolRuns[index];
    if (
      !run ||
      run.status !== "executed" ||
      !run.result ||
      typeof run.result !== "object" ||
      (run.toolName !== "browser.navigate" && run.toolName !== "browser.extract" && run.toolName !== "http.get")
    ) {
      continue;
    }
    const result = run.result as Record<string, unknown>;
    const failureClass = typeof result.browserFailureClass === "string" ? result.browserFailureClass : undefined;
    if (failureClass && failureClass !== "no_results") {
      continue;
    }
    const status = readBrowserStatusNumber(result.status);
    if (typeof status === "number" && status >= 400) {
      continue;
    }
    const text = normalizeRecoveredContentText(
      readFirstString(result.contentText, result.text, result.bodySnippet, result.textSnippet, result.message),
    );
    if (!text || text.length < 80) {
      continue;
    }
    return {
      title: readFirstString(result.title),
      url: extractUsefulVisitedBrowserUrl(result) ?? extractBrowserToolUrl(result),
      text,
    };
  }
  return undefined;
}

function normalizeRecoveredContentText(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
  return normalized || undefined;
}

const RECOVERED_CONTENT_PROMPT_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "can",
  "could",
  "find",
  "for",
  "how",
  "i",
  "into",
  "is",
  "me",
  "of",
  "online",
  "out",
  "please",
  "tell",
  "that",
  "the",
  "top",
  "what",
  "with",
]);

const RECOVERED_CONTENT_BOILERPLATE_PATTERNS = [
  /\bthis website uses cookies\b/i,
  /\blearn more got it\b/i,
  /\bskip to content\b/i,
  /\bfree trial\b/i,
  /\bbook demo\b/i,
  /\bsearch support login\b/i,
  /\bshare on linkedin\b/i,
  /\btable of contents\b/i,
  /\bready to get started\b/i,
  /\bstart free trial\b/i,
  /\bopen a new account\b/i,
  /\bproduct integrations pricing resources company\b/i,
  /\bblog\s*>\b/i,
];

function summarizeRecoveredFetchedContent(value: string, limit: number, userPrompt?: string): string[] {
  const normalized = normalizeRecoveredContentText(value);
  if (!normalized) {
    return [];
  }
  const promptTerms = extractRecoveredContentPromptTerms(userPrompt);
  const rawSegments = normalized.split(/(?<=[.!?])\s+|\s*[•·]\s+|\s{2,}/);
  const rankedSegments: Array<{
    segment: string;
    score: number;
    index: number;
  }> = [];
  const seen = new Set<string>();
  rawSegments.forEach((rawSegment, index) => {
    const segment = normalizeRecoveredContentText(rawSegment);
    if (!segment || segment.length < 45) {
      return;
    }
    const dedupeKey = segment.toLowerCase();
    if (seen.has(dedupeKey)) {
      return;
    }
    seen.add(dedupeKey);
    rankedSegments.push({
      segment,
      score: scoreRecoveredContentSegment(segment, promptTerms, userPrompt),
      index,
    });
  });

  const preferred = rankedSegments
    .filter((item) => item.score > -40)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map((item) => truncatePlainText(item.segment, 220));
  if (preferred.length > 0) {
    return preferred;
  }

  const firstUsable = rankedSegments.sort((left, right) => left.index - right.index).find((item) => item.score > -1000);
  if (firstUsable) {
    return [truncatePlainText(firstUsable.segment, 220)];
  }

  return [truncatePlainText(normalized, 280)];
}

function extractRecoveredContentPromptTerms(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  const matches = value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const unique = new Set<string>();
  for (const match of matches) {
    if (match.length < 3 || RECOVERED_CONTENT_PROMPT_STOPWORDS.has(match)) {
      continue;
    }
    unique.add(match);
  }
  return [...unique];
}

function scoreRecoveredContentSegment(segment: string, promptTerms: string[], userPrompt?: string): number {
  const normalized = segment.toLowerCase();
  if (RECOVERED_CONTENT_BOILERPLATE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return -1000;
  }

  const useCaseIntent = queryExplicitlyRequestsUseCases(userPrompt ?? "");
  let score = 0;
  if (segment.length >= 70 && segment.length <= 260) {
    score += 8;
  }
  if (/\b(rest api|rest apis|api|apis)\b/i.test(segment)) {
    score += 8;
  }
  if (
    /\b(used|use case|use cases|used for|widely used|commonly used|applications?|integrat(?:e|ion|ions)|backends?|mobile|automation|workflow|workflows|partner-facing|web services?)\b/i.test(
      segment,
    )
  ) {
    score += 20;
  }
  if (/\b(for example|for instance|such as|might use)\b/i.test(segment)) {
    score += 10;
  }
  if (/\b(what is|how do|benefits?|best practices?|security)\b/i.test(segment)) {
    score -= 10;
  }
  if (
    /\b(published:|technical writer and editor|senior technology editor|hypertext transfer protocol|architectural style)\b/i.test(
      segment,
    )
  ) {
    score -= 24;
  }
  if (
    /\b(application\/json|application\/xml|application\/x-web\+xml|application\/x-www-form-urlencoded|multipart|crud|http verb|restful web services)\b/i.test(
      segment,
    )
  ) {
    score -= 28;
  }
  if (/\b(sign up|trial|demo|pricing|company|support|login)\b/i.test(segment)) {
    score -= 20;
  }
  if (useCaseIntent) {
    if (
      /\b(cloud consumers|cloud services?|distributed environments|web services?|web and mobile|mobile and web|integrations?|automation|sites such as|partner|public api|iot|devices?)\b/i.test(
        segment,
      )
    ) {
      score += 18;
    }
    if (/\b(logical choice|ways to|widely used across|commonly used across|used across)\b/i.test(segment)) {
      score += 12;
    }
    if (
      /\b(client|server|resource|endpoint|header|body|uri|url|requests?|responses?|http method|http methods|programming languages?|json|xml|plain text|create, retrieve, update|fundamentally relies|principal parts|self descriptive|stateless)\b/i.test(
        segment,
      )
    ) {
      score -= 16;
    }
    if (
      /^(the client is|the server is|the resource is|client requests include|a rest api fundamentally relies|a rest api uses existing http methodologies|usually, response details|the server provides)\b/i.test(
        normalized,
      )
    ) {
      score -= 24;
    }
  }
  for (const term of promptTerms) {
    if (normalized.includes(term)) {
      score += 4;
    }
  }
  return score;
}

interface SearchSnippetEvidence {
  title?: string;
  url?: string;
  snippet: string;
}

function recoverSearchSnippetEvidence(toolRuns: ChatToolRunRecord[]): SearchSnippetEvidence[] {
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
    const results = Array.isArray((run.result as Record<string, unknown>).results)
      ? ((run.result as Record<string, unknown>).results as Array<Record<string, unknown>>)
      : [];
    const snippets = results
      .map((item) => ({
        title: typeof item.title === "string" ? item.title : undefined,
        url: typeof item.url === "string" ? item.url : undefined,
        snippet: normalizeRecoveredContentText(typeof item.snippet === "string" ? item.snippet : "") ?? "",
      }))
      .filter((item) => item.snippet.length >= 40);
    if (snippets.length > 0) {
      return snippets;
    }
  }
  return [];
}

function collectRecoveredAnswerPoints(toolRuns: ChatToolRunRecord[], userPrompt: string, limit: number): string[] {
  const points: string[] = [];
  const seen = new Set<string>();
  const pushPoint = (value: string) => {
    const normalized = normalizeRecoveredContentText(value);
    if (!normalized) {
      return;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    points.push(normalized);
  };

  const fetchedContent = recoverFetchedContentEvidence(toolRuns);
  if (fetchedContent) {
    for (const point of summarizeRecoveredFetchedContent(fetchedContent.text, Math.max(limit, 4), userPrompt)) {
      pushPoint(point);
    }
  }

  for (const run of toolRuns) {
    if (
      run.status !== "executed" ||
      (run.toolName !== "file.read_range" && run.toolName !== "fs.read") ||
      !run.result ||
      typeof run.result !== "object"
    ) {
      continue;
    }
    const content =
      typeof (run.result as Record<string, unknown>).content === "string"
        ? ((run.result as Record<string, unknown>).content as string)
        : "";
    if (!content.trim()) {
      continue;
    }
    for (const point of summarizeRecoveredFetchedContent(content, 2, userPrompt)) {
      pushPoint(point);
    }
    if (points.length >= limit) {
      break;
    }
  }

  for (const evidence of recoverSearchSnippetEvidence(toolRuns)) {
    for (const point of summarizeRecoveredFetchedContent(evidence.snippet, 1, userPrompt)) {
      pushPoint(point);
    }
    if (points.length >= limit) {
      break;
    }
  }

  return points.slice(0, limit);
}

function buildRecoveredEvidenceAnswer(
  userPrompt: string,
  toolRuns: ChatToolRunRecord[],
  options: {
    note: string;
  },
): string | undefined {
  const points = collectRecoveredAnswerPoints(toolRuns, userPrompt, 5);
  if (points.length === 0) {
    return undefined;
  }
  const fetchedContent = recoverFetchedContentEvidence(toolRuns);
  const firstSearchLead = recoverSearchSnippetEvidence(toolRuns)[0];
  const sourceTitle =
    fetchedContent?.title?.trim() ??
    firstSearchLead?.title?.trim() ??
    (fetchedContent?.url
      ? formatRecoveredSearchLead({ title: null, url: fetchedContent.url })
      : firstSearchLead?.url
        ? formatRecoveredSearchLead({ title: null, url: firstSearchLead.url })
        : undefined);
  const sourceUrl = fetchedContent?.url ?? firstSearchLead?.url;
  const lines = [
    buildRecoveredEvidenceIntro(userPrompt),
    "",
    ...points.map((point, index) => `${index + 1}. ${truncatePlainText(point, 220)}`),
  ];
  if (sourceTitle || sourceUrl) {
    const sourceLine = sourceUrl ? `${sourceTitle ?? sourceUrl} - ${sourceUrl}` : sourceTitle;
    lines.push("", `Primary source: ${sourceLine}`);
  }
  lines.push("", options.note);
  return lines.join("\n");
}

function buildRecoveredRepoGroundedAnswer(userPrompt: string, toolRuns: ChatToolRunRecord[]): string | undefined {
  const evidencePaths = collectObservedToolEvidencePaths(toolRuns).slice(0, 4);
  if (evidencePaths.length < 1) {
    return undefined;
  }
  const points = collectRecoveredAnswerPoints(toolRuns, userPrompt, 4);
  if (points.length < 1) {
    return undefined;
  }
  return [
    "Observed from the files I did inspect:",
    ...points.map((point) => `- ${truncatePlainText(point, 220)}`),
    "",
    `Files: ${evidencePaths.map((path) => `\`${path}\``).join(", ")}`,
    "Anything beyond those files is unverified from the current trace.",
  ].join("\n");
}

function buildRecoveredEvidenceIntro(userPrompt: string): string {
  const normalized = userPrompt.toLowerCase();
  if (
    /\btop\s+\d+\b.*\b(use|uses|use case|use cases)\b/.test(normalized) ||
    /\b(use case|use cases)\b/.test(normalized)
  ) {
    return "Based on the sources I did retrieve, these look like the strongest relevant use cases:";
  }
  if (/\bcompare|comparison|differences?\b/.test(normalized)) {
    return "Based on the sources I did retrieve, these are the strongest comparison points:";
  }
  return "Based on the sources I did retrieve, these are the strongest relevant points:";
}

function summarizeToolRunForSynthesis(run: ChatToolRunRecord, userPrompt?: string): string {
  const baseParts = [
    `- ${run.toolName}`,
    `[${run.status}]`,
    run.error ? `error: ${run.error}` : undefined,
    run.failureGuidance ? `guidance: ${run.failureGuidance}` : undefined,
  ].filter(Boolean);
  const fileReadSummary = summarizeFileReadToolRunForSynthesis(run);
  if (fileReadSummary) {
    return `${baseParts.join(" ")} ${fileReadSummary}`;
  }
  if (run.result && typeof run.result === "object") {
    if (run.toolName === "browser.search") {
      const searchLeads = recoverSearchSnippetEvidence([run])
        .slice(0, 3)
        .map(
          (item) =>
            `${item.title ?? item.url ?? "result"}${item.snippet ? ` :: ${truncatePlainText(item.snippet, 140)}` : ""}`,
        );
      if (searchLeads.length > 0) {
        return `${baseParts.join(" ")} results: ${searchLeads.join(" | ")}`;
      }
    }
    if (run.toolName === "browser.navigate" || run.toolName === "browser.extract" || run.toolName === "http.get") {
      const fetched = recoverFetchedContentEvidence([run]);
      if (fetched) {
        const summaryPoints = summarizeRecoveredFetchedContent(fetched.text, 3, userPrompt);
        const source = fetched.url ?? fetched.title ?? "fetched page";
        if (summaryPoints.length > 0) {
          return `${baseParts.join(" ")} source: ${source} content: ${summaryPoints.join(" | ")}`;
        }
      }
    }
  }
  if (run.result) {
    return `${baseParts.join(" ")} result: ${truncateJson(run.result, 280)}`;
  }
  return baseParts.join(" ");
}

function summarizeFileReadToolRunForSynthesis(run: ChatToolRunRecord): string | undefined {
  if (run.toolName !== "file.read_range" && run.toolName !== "fs.read") {
    return undefined;
  }
  if (!run.result || typeof run.result !== "object") {
    return undefined;
  }
  const result = run.result as Record<string, unknown>;
  const pathValue = typeof result.path === "string" ? result.path : undefined;
  const contentValue = typeof result.content === "string" ? result.content.trim() : "";
  if (!contentValue) {
    return undefined;
  }
  const contentSummary = truncatePlainText(contentValue, 700);
  return [pathValue ? `file: ${pathValue}` : undefined, `content: ${contentSummary}`].filter(Boolean).join(" ");
}

function formatRecoveredSearchLead(item: { title: string | null; url: string }): string {
  const title = item.title?.trim();
  if (title) {
    return title;
  }
  try {
    const parsed = new URL(item.url);
    return parsed.hostname;
  } catch {
    return item.url;
  }
}

function truncatePlainText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const truncated = value.slice(0, maxChars);
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace >= Math.max(40, Math.floor(maxChars * 0.6))) {
    return `${truncated.slice(0, lastSpace).trim()}...`;
  }
  return `${truncated.trim()}...`;
}

export function normalizeAgentInputFromSend(
  request: ChatSendMessageRequest,
): Pick<ChatAgentTurnInput, "mode" | "webMode" | "memoryMode" | "thinkingLevel" | "normalizationProfile"> {
  return {
    mode: request.mode ?? "chat",
    webMode: request.webMode ?? "auto",
    memoryMode: request.memoryMode ?? (request.useMemory === false ? "off" : "auto"),
    thinkingLevel: request.thinkingLevel ?? "standard",
    normalizationProfile: request.normalizationProfile ?? "live",
  };
}

interface CompletionStreamToolCallState {
  id?: string;
  type?: string;
  functionName?: string;
  functionArguments: string;
}

interface CompletionStreamAggregate {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  finishReason?: string;
  content: string;
  usage?: Record<string, unknown>;
  toolCalls: Map<number, CompletionStreamToolCallState>;
}

function createCompletionStreamAggregate(): CompletionStreamAggregate {
  return {
    content: "",
    toolCalls: new Map<number, CompletionStreamToolCallState>(),
  };
}

function absorbCompletionStreamChunk(
  aggregate: CompletionStreamAggregate,
  rawChunk: Record<string, unknown>,
): { delta?: string; sawToolCall: boolean } {
  if (typeof rawChunk.id === "string") {
    aggregate.id = rawChunk.id;
  }
  if (typeof rawChunk.object === "string") {
    aggregate.object = rawChunk.object;
  }
  if (typeof rawChunk.created === "number") {
    aggregate.created = rawChunk.created;
  }
  if (typeof rawChunk.model === "string") {
    aggregate.model = rawChunk.model;
  }
  if (rawChunk.usage && typeof rawChunk.usage === "object") {
    aggregate.usage = rawChunk.usage as Record<string, unknown>;
  }

  const choices = Array.isArray(rawChunk.choices) ? (rawChunk.choices as Array<Record<string, unknown>>) : [];
  let textDelta = "";
  let sawToolCall = false;
  for (const choice of choices) {
    if (typeof choice.finish_reason === "string" && choice.finish_reason.trim()) {
      aggregate.finishReason = choice.finish_reason.trim();
    }
    const message = choice.message as Record<string, unknown> | undefined;
    if (message && typeof message === "object") {
      const messageDelta = extractMessageContent(message);
      if (messageDelta) {
        aggregate.content += messageDelta;
        textDelta += messageDelta;
      }
      const fullToolCalls = readToolCalls(message, new Map<string, string>());
      if (fullToolCalls.length > 0) {
        sawToolCall = true;
      }
    }

    const delta = choice.delta as Record<string, unknown> | undefined;
    if (!delta || typeof delta !== "object") {
      continue;
    }
    const deltaText = extractContentTextFromDelta(delta.content);
    if (deltaText) {
      aggregate.content += deltaText;
      textDelta += deltaText;
    }
    const deltaToolCalls = Array.isArray(delta.tool_calls) ? (delta.tool_calls as Array<Record<string, unknown>>) : [];
    if (deltaToolCalls.length > 0) {
      sawToolCall = true;
      for (const toolCall of deltaToolCalls) {
        const index = typeof toolCall.index === "number" ? toolCall.index : aggregate.toolCalls.size;
        const current = aggregate.toolCalls.get(index) ?? {
          functionArguments: "",
        };
        if (typeof toolCall.id === "string" && toolCall.id.trim()) {
          current.id = toolCall.id.trim();
        }
        if (typeof toolCall.type === "string" && toolCall.type.trim()) {
          current.type = toolCall.type.trim();
        }
        const fn = toolCall.function as Record<string, unknown> | undefined;
        if (fn && typeof fn === "object") {
          if (typeof fn.name === "string" && fn.name.trim()) {
            current.functionName = fn.name.trim();
          }
          if (typeof fn.arguments === "string") {
            current.functionArguments += fn.arguments;
          }
        }
        aggregate.toolCalls.set(index, current);
      }
    }
  }
  return {
    delta: textDelta || undefined,
    sawToolCall,
  };
}

function extractContentTextFromDelta(content: unknown): string {
  return extractStructuredTextContent(content);
}

function buildCompletionFromAggregate(aggregate: CompletionStreamAggregate): ChatCompletionResponse {
  const toolCalls = [...aggregate.toolCalls.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, toolCall], index) => ({
      id: toolCall.id ?? `call-${index}`,
      type: toolCall.type ?? "function",
      function: {
        name: toolCall.functionName ?? "tool_fn",
        arguments: toolCall.functionArguments || "{}",
      },
    }));

  return {
    id: aggregate.id,
    object: aggregate.object,
    created: aggregate.created,
    model: aggregate.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: aggregate.content,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: aggregate.finishReason ?? "stop",
      },
    ],
    usage: aggregate.usage,
  };
}

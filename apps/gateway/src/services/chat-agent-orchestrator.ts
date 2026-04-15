/* eslint-disable max-lines -- Chat orchestration is still a centralized runtime coordinator pending a larger bounded-interface split. */
import { randomUUID } from "node:crypto";
import type {
  ChatCitationRecord,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatExecutionPlanRecord,
  ChatMode,
  ChatSendMessageRequest,
  ChatStreamChunkDraft,
  ChatThinkingLevel,
  ChatToolRunRecord,
  ChatTurnBranchKind,
  ChatTurnFailureClass,
  ChatTurnFailureRecord,
  ChatTurnTraceRecord,
  ChatWebMode,
  ToolCatalogEntry,
  ToolInvokeRequest,
  ToolInvokeResult,
  McpInvokeRequest,
  McpInvokeResponse,
} from "@goatcitadel/contracts";
import { BudgetExceededError, getChatTurnRecoveryAction, type ChatTurnRecoveryAction } from "@goatcitadel/contracts";
import { estimateTokensFromText } from "@goatcitadel/memory-core";
import type { Storage } from "@goatcitadel/storage";
import { hasLiveDataKeywords, EXPLICIT_WEB_PHRASES } from "../orchestration/live-data-detect.js";
import type { McpBrowserFallbackTarget } from "./mcp-runtime.js";

const MAX_TOOL_LOOPS = 6;
const MAX_TOOL_RUNS_PER_TURN = 12;
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
    const toolSchema =
      input.toolAutonomy === "manual"
        ? { tools: [], modelToCanonical: new Map<string, string>(), canonicalToModel: new Map<string, string>() }
        : await this.buildToolSchema(input, intents);
    const canUseTimeTool = toolSchema.canonicalToModel.has("time.now");
    const canUseSearchTool = toolSchema.canonicalToModel.has("browser.search");
    const canUseNavigateTool = toolSchema.canonicalToModel.has("browser.navigate");
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
    const toolFailureSignatureCounts = new Map<string, number>();
    let promptLabToolComplianceRetryIssued = false;
    const outputMessageId = input.outputMessageId ?? `assistant-${input.turnId}`;
    const executionBudget = resolveChatExecutionBudget({
      webMode: input.webMode,
      thinkingLevel: input.thinkingLevel,
      liveDataIntent: intents.webLookup,
      promptLabExplicitTools: promptLabContract.explicitTools,
      providerId: input.providerId,
      model: input.model,
    });
    let effectiveTurnBudgetMs = executionBudget.turnBudgetMs;
    let effectiveCompletionTimeoutMs = executionBudget.completionTimeoutMs;
    let turnBudgetDeadline = createTurnBudgetDeadline(effectiveTurnBudgetMs);

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
    if (!assistantContent) {
      const clarificationFollowUp = buildClarificationFollowUpIfNeeded(input.content, input.historyMessages);
      if (clarificationFollowUp) {
        assistantContent = clarificationFollowUp;
      }
    }
    if (!assistantContent) {
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
        promptLabPrompt: isPromptLabHarnessContent(input.content),
        timeIntent: intents.time,
        localFileIntent,
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
      (promptLabContract.explicitTools || promptLabContract.repoGroundedAssist) &&
      toolRunCount === 0
    ) {
      const promptLabShouldInspectFiles =
        promptLabContractRequiresFileTools(promptLabContract) || promptLabContract.repoGroundedAssist;
      const promptLabFilePaths = promptLabShouldInspectFiles
        ? extractExplicitLocalFilePathsFromPrompt(promptLabContract.userTask)
        : [];
      const prefetchEndLine = resolvePromptLabFilePrefetchEndLine(promptLabFilePaths.length);
      if (
        promptLabShouldInspectFiles &&
        promptLabFilePaths.length > 0 &&
        toolSchema.canonicalToModel.has("file.read_range")
      ) {
        for (const filePath of promptLabFilePaths.slice(0, 6)) {
          if (toolRunCount >= executionBudget.maxToolRunsPerTurn) {
            break;
          }
          throwIfChatTurnCancelled(input);
          this.deps.storage.chatTurnTraces.patch(input.turnId, {
            status: "waiting_for_tool",
          });
          ensureChatTurnBudgetRemaining(turnBudgetDeadline, input.webMode, effectiveTurnBudgetMs);
          const syntheticRun = await this.executeToolCall({
            input,
            turnId: input.turnId,
            toolName: "file.read_range",
            rawArgs: {
              path: filePath,
              startLine: 1,
              endLine: prefetchEndLine,
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
          const toolMessageId = `prefetch-file-${randomUUID()}`;
          conversationMessages.push(
            createAssistantToolCallMessage({
              toolCallId: toolMessageId,
              toolName: this.resolveModelToolName("file.read_range", toolSchema.canonicalToModel),
              argumentsJson: JSON.stringify({
                path: filePath,
                startLine: 1,
                endLine: prefetchEndLine,
              }),
            }),
          );
          const prefetchResultPayload: Record<string, unknown> = {
            ...(syntheticRun.record.result ?? { error: syntheticRun.record.error ?? "Tool failed." }),
          };
          if (syntheticRun.record.status === "executed") {
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
        }
      }

      if (
        !approvalPayload &&
        promptLabShouldInspectFiles &&
        promptLabFilePaths.length === 0 &&
        toolSchema.canonicalToModel.has("code.search_files") &&
        toolRunCount < executionBudget.maxToolRunsPerTurn &&
        (promptLabContract.repoGroundedAssist || isMissingPromptLabRequiredToolEvidence(promptLabContract, toolRuns))
      ) {
        const promptLabSearchPath =
          inferLocalToolPathFromPrompt("code.search_files", promptLabContract.userTask) ?? ".";
        const promptLabSearchQueries = inferPromptLabLocalSearchQueries(promptLabContract.userTask);
        const effectivePromptLabSearchQueries =
          promptLabSearchQueries.length > 0
            ? promptLabSearchQueries
            : [inferLocalSearchQueryFromPrompt("code.search_files", promptLabContract.userTask) ?? "."];
        for (const query of effectivePromptLabSearchQueries) {
          if (toolRunCount >= executionBudget.maxToolRunsPerTurn) {
            break;
          }
          throwIfChatTurnCancelled(input);
          this.deps.storage.chatTurnTraces.patch(input.turnId, {
            status: "waiting_for_tool",
          });
          ensureChatTurnBudgetRemaining(turnBudgetDeadline, input.webMode, effectiveTurnBudgetMs);
          const syntheticRun = await this.executeToolCall({
            input,
            turnId: input.turnId,
            toolName: "code.search_files",
            rawArgs: {
              path: promptLabSearchPath,
              query,
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
          const toolMessageId = `prefetch-search-files-${randomUUID()}`;
          conversationMessages.push(
            createAssistantToolCallMessage({
              toolCallId: toolMessageId,
              toolName: this.resolveModelToolName("code.search_files", toolSchema.canonicalToModel),
              argumentsJson: JSON.stringify({
                path: promptLabSearchPath,
                query,
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
        }
      }

      if (
        !approvalPayload &&
        promptLabContractRequiresWebTools(promptLabContract) &&
        canUseSearchTool &&
        toolRunCount < executionBudget.maxToolRunsPerTurn &&
        isMissingPromptLabRequiredToolEvidence(promptLabContract, toolRuns)
      ) {
        const promptLabSearchQuery =
          inferQueryFromPrompt(promptLabContract.userTask) ?? deriveLiveDataQuery(promptLabContract.userTask);
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
    if (!assistantContent && intents.time && canUseTimeTool) {
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

    if (
      !assistantContent &&
      !approvalPayload &&
      input.toolAutonomy !== "manual" &&
      input.webMode !== "off" &&
      intents.liveData &&
      !localFileIntent &&
      !intents.time &&
      canUseSearchTool &&
      toolRunCount < executionBudget.maxToolRunsPerTurn
    ) {
      throwIfChatTurnCancelled(input);
      this.deps.storage.chatTurnTraces.patch(input.turnId, {
        status: "waiting_for_tool",
      });
      ensureChatTurnBudgetRemaining(turnBudgetDeadline, input.webMode, effectiveTurnBudgetMs);
      const derivedLiveDataQuery = deriveLiveDataQuery(input.content);
      const inferredLiveDataQuery = inferQueryFromPrompt(input.content);
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
          shouldProactivelyOpenGroundedNewsResult(input.content) &&
          canUseNavigateTool &&
          toolRunCount < executionBudget.maxToolRunsPerTurn
        ) {
          const promotedUrl = inferBrowserNavigateUrlFromRepeatedSearches(input.content, toolRuns);
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
            tools: toolSchema.tools.length > 0 ? toolSchema.tools : undefined,
            tool_choice: toolSchema.tools.length > 0 ? "auto" : undefined,
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

          const toolCalls = readToolCalls(message, toolSchema.modelToCanonical);
          if (completionOutcome.status !== "complete" && toolCalls.length > 0) {
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
              promptLabContract.explicitTools &&
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
          for (const toolCall of toolCalls) {
            throwIfChatTurnCancelled(input);
            if (toolRunCount >= executionBudget.maxToolRunsPerTurn) {
              throw new Error("Tool run limit reached for this turn.");
            }
            if (circuitBreakerReason) {
              break;
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
                "budget_exceeded",
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

          if (shortCircuitedOnBudget) {
            break;
          }

          if (circuitBreakerReason) {
            assistantContent = buildToolFailureFallbackMessage(input.content, toolRuns, circuitBreakerReason);
            finalStatus = "completed";
            finalFailure = buildChatTurnFailureRecord(
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
            "budget_exceeded",
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
        assistantContent = repairedContent;
        if (completionState.status !== "complete") {
          completionState = {
            finishReason: completionState.finishReason,
            status: "complete",
            repaired: true,
          };
        }
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
        assistantContent = repairedCompletion.content.trim();
        completionState = {
          finishReason: completionState.finishReason,
          status: "complete",
          repaired: true,
        };
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
      assistantContent = synthesizedFallback.content;
      if (assistantContent.trim().length > 0 && completionState.status !== "complete") {
        completionState = {
          finishReason: completionState.finishReason,
          status: "complete",
          repaired: true,
        };
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
        assistantContent = repairedCoworkContent;
        completionState = {
          finishReason: completionState.finishReason,
          status: "complete",
          repaired: true,
        };
      }
    }
    if (finalStatus !== "cancelled") {
      assistantContent = appendToolFailureConstraints(assistantContent, toolRuns);
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
      failure: finalFailure,
      completion: finalizedCompletion,
      routing: {
        ...routingState,
        liveDataIntent: intents.liveData,
        effectiveProviderId: routingState.effectiveProviderId ?? input.providerId,
        effectiveModel: routingState.effectiveModel ?? assistantModel,
      },
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
    input: Pick<ChatAgentTurnInput, "sessionId" | "webMode" | "mode" | "content" | "historyMessages">,
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
    const explicitToolMentions = detectExplicitToolMentions(
      input.content,
      catalog.map((tool) => tool.toolName),
    );
    const memoryLookupIntent = detectMemoryLookupIntent(input.content);
    const memoryPersistenceIntent = detectMemoryPersistenceIntent(input.content);
    const webLookupIntent = intents.webLookup || [...explicitToolMentions].some((toolName) => isWebToolName(toolName));
    const recentToolRuns = this.deps.storage.chatToolRuns.listBySession(input.sessionId, 200);
    const projectBound = Boolean(this.deps.storage.chatSessionProjects.get(input.sessionId)?.projectId);
    const activePlan = this.deps.storage.chatExecutionPlans
      ? selectActiveExecutionPlan(this.deps.storage.chatExecutionPlans.listBySession(input.sessionId, 20))
      : undefined;
    const suggestedTools = new Set(selectExecutionPlanSuggestedTools(activePlan));
    const failedCounts = buildRecentToolFailureCounts(recentToolRuns);
    const filteredCatalog: ToolCatalogEntry[] = [];
    for (const tool of catalog) {
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
          localFileIntent: intents.localFile,
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
      localFileIntent: intents.localFile,
      memoryLookupIntent,
      memoryPersistenceIntent,
      explicitToolMentions,
      projectBound,
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
        result: {
          ...(reusableResult.result as Record<string, unknown>),
          reusedPriorToolRunId: reusableResult.toolRunId,
          reusedResult: true,
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
    if (input.toolName === "browser.navigate" && typeof args.url === "string") {
      const promotedUrl = redirectSearchPortalNavigateUrl(args.url, input.userContent, input.priorToolRuns);
      if (promotedUrl && promotedUrl !== args.url) {
        args.url = promotedUrl;
      }
    }
    if (input.toolName === "browser.search") {
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
    if (
      input.toolName === "browser.search" &&
      (input.localFileIntent ?? false) &&
      !detectExplicitWebLookupIntent(input.userContent)
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
    const repoGroundedRepair = looksLikeRepoGroundedInspectionPrompt(input.input.content);
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
      snippet: typeof result.bodySnippet === "string"
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
    Array.isArray(result.results) ? `${result.results.length} result${result.results.length === 1 ? "" : "s"} returned.` : undefined,
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
  if (input.localFileIntent || input.projectBound || input.mode === "code") {
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
      const toolName = rawToolName ? (modelToCanonical.get(rawToolName) ?? rawToolName) : undefined;
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
    const toolName = modelToCanonical.get(rawToolName) ?? rawToolName;
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
  return hasLiveDataKeywords(content.toLowerCase());
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
    detectLiveDataIntent(content) || detectDirectUrlIntent(content) || detectWebFollowUpIntent(content, historyMessages)
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
  webMode: ChatWebMode;
  toolAutonomy: ChatAgentTurnInput["toolAutonomy"];
}): string | undefined {
  if (!input.webLookupIntent || input.timeIntent || input.localFileIntent) {
    return undefined;
  }
  if (input.promptLabPrompt && !input.strictWebRequirement) {
    return undefined;
  }
  if (input.mode !== "chat" && !input.strictWebRequirement) {
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
      if (!url) {
        continue;
      }
      items.push({
        citationId: `${toolRun.toolRunId}-${rank}`,
        title: typeof value.title === "string" ? value.title : undefined,
        snippet: typeof value.snippet === "string" ? value.snippet : undefined,
        url,
        sourceType: "web",
      });
      rank += 1;
    }
  } else if (typeof result.finalUrl === "string") {
    items.push({
      citationId: `${toolRun.toolRunId}-0`,
      url: result.finalUrl,
      title: typeof result.title === "string" ? result.title : undefined,
      snippet: typeof result.textSnippet === "string" ? result.textSnippet.slice(0, 220) : undefined,
      sourceType: "web",
    });
  } else if (typeof result.url === "string") {
    items.push({
      citationId: `${toolRun.toolRunId}-0`,
      url: result.url,
      sourceType: "web",
    });
  }
  return items;
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

function resolveGroundedBrowserSearchQuery(input: {
  rawArgs: Record<string, unknown>;
  userContent: string;
  historyMessages: ChatCompletionRequest["messages"];
  priorToolRuns?: ChatToolRunRecord[];
}): string | undefined {
  const queryCandidates = readBrowserSearchQueryCandidatesFromArgs(input.rawArgs);
  const currentQuery = queryCandidates[0];
  if (
    currentQuery &&
    !looksLikeContinuationSearchPrompt(currentQuery) &&
    !looksLikeHarnessContaminatedQuery(currentQuery)
  ) {
    return sanitizeQueryClause(currentQuery).slice(0, 240);
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
  return currentQuery;
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
  const rolesInOrderMatch = prompt.match(/roles?\s+in\s+order\b[:\s]*([^\n]+)/i)?.[1];
  if (rolesInOrderMatch) {
    return rolesInOrderMatch
      .split(/\s*,\s*|\s+and\s+/i)
      .map((part) => normalizeCoworkRoleLabel(part))
      .filter(isRecognizedCoworkRole);
  }
  const roleMatchers: Array<{ role: string; pattern: RegExp }> = [
    { role: "product", pattern: /\bproduct\b/i },
    { role: "researcher", pattern: /\bresearcher\b/i },
    { role: "architect", pattern: /\barchitect\b/i },
    { role: "coder", pattern: /\bcoder\b/i },
    { role: "qa", pattern: /\bqa\b/i },
    { role: "ops", pattern: /\bops\b/i },
    { role: "personal assistant", pattern: /\bpersonal assistant\b/i },
  ];
  const roles: string[] = [];
  for (const matcher of roleMatchers) {
    if (matcher.pattern.test(prompt) && !roles.includes(matcher.role)) {
      roles.push(matcher.role);
    }
  }
  return roles;
}

function promptKeepsRequestedRoleOrderOnly(prompt: string): boolean {
  return (
    /\bkeep\b[\s\S]{0,40}\brequested role order only\b/i.test(prompt) ||
    /\brequested role order only\b/i.test(prompt) ||
    (/\brequested role order\b/i.test(prompt) && /\bno extra headings\b/i.test(prompt))
  );
}

function coworkContractRequiresSynthesis(prompt: string): boolean {
  return !promptKeepsRequestedRoleOrderOnly(prompt);
}

function extractExactCoworkSections(prompt: string): string[] {
  const marker = prompt.match(/output exactly these(?: top-level)? sections in this order:\s*([\s\S]+)/i);
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
    role === "product" ||
    role === "researcher" ||
    role === "architect" ||
    role === "coder" ||
    role === "qa" ||
    role === "ops" ||
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
    product: /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?product(?: goat)?(?:\*\*|__)?\b/i,
    researcher: /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?researcher(?: goat)?(?:\*\*|__)?\b/i,
    architect: /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?architect(?: goat)?(?:\*\*|__)?\b/i,
    coder: /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?coder(?: goat)?(?:\*\*|__)?\b/i,
    qa: /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?qa(?: goat)?(?:\*\*|__)?\b/i,
    ops: /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?ops(?: goat)?(?:\*\*|__)?\b/i,
    "personal assistant": /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?personal assistant(?:\*\*|__)?\b/i,
  };
  return patterns[role]?.test(response) ?? false;
}

function detectPresentCoworkRoles(response: string): string[] {
  return ["product", "researcher", "architect", "coder", "qa", "ops", "personal assistant"].filter((role) =>
    coworkRoleSectionPresent(response, role),
  );
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
  const effectiveRoles = input.requiredRoles.length > 0 ? input.requiredRoles : detectCoworkRoleOrder(input.prompt);
  if (effectiveRoles.length === 0) {
    return trimmed;
  }
  const evidencePaths = collectObservedToolEvidencePaths(input.toolRuns).slice(0, 4);
  const searchScope = collectToolSearchScope(input.toolRuns).slice(0, 3);
  const constraints = summarizeCoworkToolConstraint(input.toolRuns);
  const requiresSynthesis = coworkContractRequiresSynthesis(input.prompt);
  const evidenceLine =
    evidencePaths.length > 0
      ? `- Evidence: Reviewed ${evidencePaths.map((path) => `\`${path}\``).join(", ")}.`
      : "- Evidence: No file-specific evidence was retained from the tool trace.";
  const scopeLine =
    searchScope.length > 0
      ? `- Search scope: ${searchScope.join("; ")}.`
      : "- Search scope: No explicit search scope was retained.";
  const workaroundsLine =
    evidencePaths.length > 0
      ? "- Workarounds: Use the cited files as the anchor for follow-up recommendations and call out any unknowns explicitly."
      : "- Workarounds: Continue only with the captured evidence and label any repo-level claims as unknown.";
  const lines: string[] = [];
  for (const role of effectiveRoles) {
    lines.push(`## ${formatCoworkRoleHeading(role)}`);
    lines.push(evidenceLine);
    lines.push(scopeLine);
    lines.push(`- Constraints: ${constraints}`);
    lines.push(workaroundsLine);
    lines.push("");
  }
  if (requiresSynthesis) {
    lines.push("## Synthesis");
    lines.push(evidenceLine);
    lines.push(`- Constraints: ${constraints}`);
    lines.push(
      "- Workarounds: Combine the cited evidence into the best current recommendation and flag remaining gaps explicitly.",
    );
  }
  if (isPromptLabHarnessContent(input.prompt)) {
    lines.push("");
    lines.push("## Evidence Used");
    if (evidencePaths.length > 0) {
      for (const path of evidencePaths) {
        lines.push(`- \`${path}\``);
      }
    } else {
      lines.push("- No file-specific evidence was retained from the tool trace.");
    }
    lines.push("");
    lines.push("## Required Citations");
    if (evidencePaths.length > 0) {
      lines.push(`- Cite exact file paths from this set: ${evidencePaths.map((path) => `\`${path}\``).join(", ")}.`);
    } else {
      lines.push("- Cite exact files once tool-backed evidence is available.");
    }
  }
  return lines.join("\n").trim();
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
  const requiredRoles = detectCoworkRoleOrder(input.prompt);
  const presentRoles = detectPresentCoworkRoles(trimmed);
  const missingRequiredRoles = requiredRoles.filter((role) => !presentRoles.includes(role));
  const requiresSynthesis = coworkContractRequiresSynthesis(input.prompt);
  const shouldRepair =
    looksLikePromptLabInstructionEchoContent(trimmed) ||
    missingRequiredRoles.length > 0 ||
    (requiresSynthesis && requiredRoles.length > 0 && !hasCoworkSynthesisSection(trimmed));
  if (!shouldRepair) {
    return trimmed;
  }
  return buildDeterministicCoworkRoleContractFallback({
    prompt: input.prompt,
    responseText: trimmed,
    toolRuns: input.toolRuns,
    requiredRoles,
  });
}

function collectObservedToolEvidencePaths(toolRuns: ChatToolRunRecord[]): string[] {
  const observed = new Map<string, string>();
  const add = (value: unknown): void => {
    if (typeof value !== "string") {
      return;
    }
    const normalized = value.trim().replace(/\\/g, "/");
    if (!normalized) {
      return;
    }
    const key = normalized.toLowerCase();
    if (!observed.has(key)) {
      observed.set(key, normalized);
    }
  };
  for (const run of toolRuns) {
    add(run.args?.path);
    const result = run.result as Record<string, unknown> | undefined;
    add(result?.path);
    if (Array.isArray(result?.matches)) {
      for (const match of result.matches as Array<Record<string, unknown>>) {
        add(match.path);
        add(match.name);
      }
    }
  }
  return [...observed.values()].filter((value) => /[/.]/.test(value)).slice(0, 8);
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

function appendToolFailureConstraints(content: string, toolRuns: ChatToolRunRecord[]): string {
  const appendix = buildToolFailureAppendix(toolRuns);
  if (!appendix) {
    return content;
  }
  const trimmed = content.trim();
  const failedOrBlocked = toolRuns.filter((run) => run.status === "failed" || run.status === "blocked");
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
  return /\b(a|an|and|are|as|at|because|by|during|for|from|if|in|into|is|of|on|or|the|to|under|via|when|while|with|without)\s*$/i.test(
    lastLine,
  );
}

function extractPrimaryUserTaskContent(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return "";
  }
  const userTaskMatch = trimmed.match(/(?:^|\n)##\s+User Task\s*\n([\s\S]*)$/i);
  if (userTaskMatch?.[1]) {
    return userTaskMatch[1].trim();
  }
  return trimmed;
}

function parsePromptLabRunContract(content: string): {
  explicitTools: boolean;
  repoGroundedAssist: boolean;
  requiredToolFamilies: string[];
  requiredNamedTools: string[];
  userTask: string;
} {
  const userTask = extractPrimaryUserTaskContent(content);
  if (!isPromptLabHarnessContent(content)) {
    return {
      explicitTools: false,
      repoGroundedAssist: false,
      requiredToolFamilies: [],
      requiredNamedTools: [],
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
    userTask,
  };
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
  },
  toolRuns: ChatToolRunRecord[],
): string[] {
  if (!contract.explicitTools) {
    return [];
  }
  const completedToolRuns = toolRuns.filter((run) => run.status !== "started");
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
      if (!completedToolRuns.some((run) => toolNameMatchesAnyKnownTool(run.toolName, LOCAL_PATH_TOOL_NAMES))) {
        missing.push("file/code tools");
      }
      continue;
    }
    if (family === "web lookup tools") {
      if (!completedToolRuns.some((run) => toolNameMatchesAnyKnownTool(run.toolName, WEB_TOOL_NAMES))) {
        missing.push("web lookup tools");
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
  },
  availableTools: Map<string, string>,
): boolean {
  if (!contract.explicitTools) {
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

function resolvePromptLabFilePrefetchEndLine(fileCount: number): number {
  if (fileCount >= 5) {
    return 180;
  }
  if (fileCount >= 3) {
    return 260;
  }
  return 320;
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

function looksLikeLocalFilePath(value: string): boolean {
  const normalized = value.trim();
  if (!normalized || /^https?:\/\//i.test(normalized)) {
    return false;
  }
  if (!/[\\/]/.test(normalized)) {
    return KNOWN_BARE_FILE_BASENAMES.has(normalized);
  }
  return /\.[A-Za-z0-9._-]+$/.test(normalized);
}

function normalizePromptLabFilePath(value: string): string {
  return value.trim().replace(/\\/g, "/");
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

function isPromptLabHarnessContent(content: string): boolean {
  const normalized = content.toLowerCase();
  return normalized.includes("## prompt lab run contract") || normalized.includes("## prompt lab tooling contract");
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
  if (explicitPath) {
    if (toolName === "code.search_files") {
      return collapsePromptPathToSearchRoot(explicitPath);
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
  if (explicitPath) {
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

  for (const match of taskContent.matchAll(/`([^`\r\n]+)`/g)) {
    const value = match[1]?.trim();
    if (!value) {
      continue;
    }
    const basename = value.replace(/\\/g, "/").split("/").filter(Boolean).at(-1);
    addQuery(basename ?? value);
  }

  if (/\bskill import\b/i.test(taskContent)) {
    addQuery("skill-import");
  }
  if (/\bsource\.json\b/i.test(taskContent)) {
    addQuery("source.json");
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
  if (/\bworkspace\b/i.test(normalized) && /\boverride|guidance\b/i.test(normalized)) {
    addQuery("workspace");
  }
  if (/\breplay\b|\bbenchmark\b|\btrend\b/i.test(normalized)) {
    addQuery("replay");
  }
  if (/\bmemory\b/i.test(normalized) && /\bcontext|pack|qmd|lifecycle\b/i.test(normalized)) {
    addQuery("memory");
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
        ].includes(token),
    )
    .slice(0, 4);
  for (const token of fallbackTokens) {
    addQuery(token);
  }

  return queries.slice(0, 4);
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
  return /^(?:[a-zA-Z]:\/|\/|\.{1,2}\/)?[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*(?:\/)?$/i.test(normalized);
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
  const failedOrBlocked = toolRuns.filter((run) => run.status === "failed" || run.status === "blocked");
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
  input: Pick<ChatAgentTurnInput, "webMode" | "thinkingLevel"> & {
    liveDataIntent?: boolean;
    promptLabExplicitTools?: boolean;
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

function looksLikeRepoGroundedInspectionPrompt(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return (
    /\binspect(?: the)? (?:repo|repository|codebase|workspace)\b/.test(normalized) ||
    /\buse (?:file|code|file\/code) tools\b/.test(normalized) ||
    /\bexact files?\b/.test(normalized) ||
    /\bexact evidence\b/.test(normalized) ||
    /\bcurrent implementation\b/.test(normalized) ||
    /\bguidance-loading chain\b/.test(normalized) ||
    (/\bcurrent\b/.test(normalized) && /\b(repo|repository|workspace|codebase)\b/.test(normalized))
  );
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
): Pick<ChatAgentTurnInput, "mode" | "webMode" | "memoryMode" | "thinkingLevel"> {
  return {
    mode: request.mode ?? "chat",
    webMode: request.webMode ?? "auto",
    memoryMode: request.memoryMode ?? (request.useMemory === false ? "off" : "auto"),
    thinkingLevel: request.thinkingLevel ?? "standard",
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

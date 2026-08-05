import type {
  ChatCompletionResponse,
  ChatToolRunRecord,
  ChatTurnTraceRecord,
  ChatUserInputPromptRecord,
  ToolCatalogEntry,
  ToolInvokeRequest,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import { NotFoundError } from "@goatcitadel/contracts";
import {
  ChatTurnAgentRunner,
  type ChatTurnAgentRunnerDeps,
  type ChatTurnAgentRunnerInput,
} from "./chat-turn-agent-runner.js";

type ExecuteToolCallInput = {
  input: ChatTurnAgentRunnerInput;
  turnId: string;
  toolName: string;
  rawArgs: Record<string, unknown>;
  localFileIntent?: boolean;
  priorToolRuns?: ChatToolRunRecord[];
};

type ExecuteToolCallResult = {
  record: ChatToolRunRecord & {
    failureGuidance?: string;
  };
  approvalExpiresAt?: string;
  chunk?: Record<string, unknown>;
  userInputPrompt?: ChatUserInputPromptRecord;
};

/**
 * Adapts legacy canned tool mocks to the effect-aware runner contract.
 *
 * Test doubles return their policy/execution outcome directly and have no
 * real side effect to fence. An `executed` result therefore represents the
 * point where the mock crossed into execution, while `approval_required` and
 * `blocked` remain pre-dispatch policy outcomes.
 */
export function createEffectAwareInvokeToolForTest(
  invokeTool: ChatTurnAgentRunnerDeps["invokeTool"],
): NonNullable<ChatTurnAgentRunnerDeps["invokeToolWithEffectTruth"]> {
  return async (request, options) => {
    const result = await invokeTool(request);
    if (result.outcome === "executed") {
      await options.executionFence();
    }
    return result;
  };
}

/** Runner fixture that preserves explicit effect-aware mocks when supplied. */
export class EffectAwareChatTurnAgentRunner extends ChatTurnAgentRunner {
  constructor(deps: ChatTurnAgentRunnerDeps) {
    super({
      ...deps,
      invokeToolWithEffectTruth: deps.invokeToolWithEffectTruth ?? createEffectAwareInvokeToolForTest(deps.invokeTool),
    });
  }
}

export function createToolCatalog(toolNames: string[] = ["browser.search"]): ToolCatalogEntry[] {
  return toolNames.map((toolName) => {
    if (toolName === "memory.search") {
      return {
        toolName: "memory.search",
        category: "knowledge",
        riskLevel: "safe",
        requiresApproval: false,
        description: "Search memory",
        argSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
        examples: [],
        pack: "knowledge",
        recommendedContexts: ["chat", "cowork", "code"],
        preferredForIntents: ["memory_lookup", "project_context"],
      };
    }
    if (toolName === "memory.read") {
      return {
        toolName: "memory.read",
        category: "knowledge",
        riskLevel: "safe",
        requiresApproval: false,
        description: "Read memory",
        argSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: [],
        },
        examples: [],
        pack: "knowledge",
        recommendedContexts: ["chat", "cowork", "code"],
        preferredForIntents: ["memory_lookup", "project_context"],
      };
    }
    if (toolName === "docs.search") {
      return {
        toolName: "docs.search",
        category: "knowledge",
        riskLevel: "safe",
        requiresApproval: false,
        description: "Search ingested documents",
        argSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            namespace: { type: "string" },
            limit: { type: "integer" },
          },
          required: ["query"],
        },
        examples: [],
        pack: "knowledge",
        recommendedContexts: ["chat", "cowork", "code"],
        preferredForIntents: ["project_context", "memory_lookup"],
      };
    }
    if (toolName === "memory.write" || toolName === "memory.upsert") {
      return {
        toolName,
        category: "knowledge",
        riskLevel: "safe",
        requiresApproval: false,
        description: toolName === "memory.write" ? "Write memory" : "Upsert memory",
        argSchema: {
          type: "object",
          properties: {
            namespace: { type: "string" },
            title: { type: "string" },
            content: { type: "string" },
          },
          required: ["namespace", "title", "content"],
        },
        examples: [],
        pack: "knowledge",
        recommendedContexts: ["chat", "cowork", "code"],
        preferredForIntents: ["memory_persist"],
      };
    }
    if (toolName === "browser.navigate") {
      return {
        toolName: "browser.navigate",
        category: "research",
        riskLevel: "safe",
        requiresApproval: false,
        description: "Navigate",
        argSchema: {
          type: "object",
          properties: {
            url: { type: "string" },
          },
          required: ["url"],
        },
        examples: [],
        pack: "core",
      };
    }
    if (toolName === "presentations.create") {
      return {
        toolName: "presentations.create",
        category: "knowledge",
        riskLevel: "caution",
        requiresApproval: false,
        description: "Create a PowerPoint presentation artifact",
        argSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            title: { type: "string" },
            subtitle: { type: "string" },
            design: {
              type: "object",
              properties: {
                mode: { type: "string" },
                skillId: { type: "string" },
              },
            },
            slides: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  bullets: { type: "array", items: { type: "string" } },
                },
                required: ["title"],
              },
            },
          },
          required: ["path", "title", "slides"],
        },
        examples: [],
        pack: "core",
        recommendedContexts: ["chat", "cowork"],
        preferredForIntents: ["presentation", "slide_deck", "powerpoint", "artifact_output"],
      };
    }
    if (toolName === "documents.create") {
      return {
        toolName: "documents.create",
        category: "knowledge",
        riskLevel: "caution",
        requiresApproval: false,
        description: "Create a document artifact",
        argSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            format: { type: "string" },
            title: { type: "string" },
            body: { type: "string" },
            design: {
              type: "object",
              properties: {
                mode: { type: "string" },
                skillId: { type: "string" },
              },
            },
            sections: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  heading: { type: "string" },
                  body: { type: "string" },
                  bullets: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
          required: ["path", "title"],
        },
        examples: [],
        pack: "core",
        recommendedContexts: ["chat", "cowork"],
        preferredForIntents: ["document_generation", "artifact_output", "report", "pdf", "docx"],
      };
    }
    if (toolName === "browser.extract") {
      return {
        toolName: "browser.extract",
        category: "research",
        riskLevel: "safe",
        requiresApproval: false,
        description: "Extract page text",
        argSchema: {
          type: "object",
          properties: {
            url: { type: "string" },
          },
          required: ["url"],
        },
        examples: [],
        pack: "core",
      };
    }
    if (toolName === "http.get") {
      return {
        toolName: "http.get",
        category: "http",
        riskLevel: "safe",
        requiresApproval: false,
        description: "HTTP GET",
        argSchema: {
          type: "object",
          properties: {
            url: { type: "string" },
          },
          required: ["url"],
        },
        examples: [],
        pack: "core",
      };
    }
    if (toolName === "file.read_range") {
      return {
        toolName: "file.read_range",
        category: "fs",
        riskLevel: "safe",
        requiresApproval: false,
        description: "Read file range",
        argSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            startLine: { type: "integer" },
            endLine: { type: "integer" },
          },
          required: ["path", "startLine", "endLine"],
        },
        examples: [],
        pack: "devops",
        recommendedContexts: ["cowork", "code", "project_bound"],
        preferredForIntents: ["local_file", "inspect_code", "targeted_read"],
      };
    }
    if (toolName === "fs.list" || toolName === "fs.stat") {
      return {
        toolName,
        category: "fs",
        riskLevel: "safe",
        requiresApproval: false,
        description: toolName === "fs.list" ? "List files and directories" : "Read file metadata",
        argSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
          required: ["path"],
        },
        examples: [],
        pack: "devops",
        recommendedContexts: ["cowork", "code", "project_bound"],
        preferredForIntents: ["local_file", "inspect_code", "read_file"],
      };
    }
    if (toolName === "file.find") {
      return {
        toolName: "file.find",
        category: "fs",
        riskLevel: "safe",
        requiresApproval: false,
        description: "Find text in files",
        argSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            pattern: { type: "string" },
          },
          required: ["path", "pattern"],
        },
        examples: [],
        pack: "devops",
        recommendedContexts: ["cowork", "code", "project_bound"],
        preferredForIntents: ["local_file", "inspect_code", "search_text"],
      };
    }
    if (toolName === "code.search" || toolName === "code.search_files") {
      return {
        toolName,
        category: "fs",
        riskLevel: "safe",
        requiresApproval: false,
        description: toolName === "code.search" ? "Search code" : "Search file names",
        argSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            query: { type: "string" },
          },
          required: ["path", "query"],
        },
        examples: [],
        pack: "devops",
        recommendedContexts: ["cowork", "code", "project_bound"],
        preferredForIntents: [
          "local_file",
          "inspect_code",
          toolName === "code.search" ? "search_code" : "search_files",
        ],
      };
    }
    if (toolName === "http.post") {
      return {
        toolName: "http.post",
        category: "http",
        riskLevel: "danger",
        requiresApproval: true,
        description: "HTTP POST",
        argSchema: {
          type: "object",
          properties: {
            url: { type: "string" },
          },
          required: ["url"],
        },
        examples: [],
        pack: "core",
      };
    }
    if (toolName === "shell.exec" || toolName === "shell.exec_background") {
      return {
        toolName,
        category: "shell",
        riskLevel: "danger",
        requiresApproval: true,
        description:
          toolName === "shell.exec" ? "Execute a shell command" : "Execute a shell command in the background",
        argSchema: {
          type: "object",
          properties: {
            command: { type: "string" },
          },
          required: ["command"],
        },
        examples: [],
        pack: "devops",
        recommendedContexts: ["code"],
        preferredForIntents: ["run_command", "project_inspection"],
      };
    }
    if (toolName === "git.exec") {
      return {
        toolName: "git.exec",
        category: "shell",
        riskLevel: "danger",
        requiresApproval: true,
        description: "Execute a git command",
        argSchema: {
          type: "object",
          properties: {
            command: { type: "string" },
          },
          required: ["command"],
        },
        examples: [],
        pack: "devops",
        recommendedContexts: ["code"],
        preferredForIntents: ["run_command", "project_inspection"],
      };
    }
    if (toolName === "browser.context.configure") {
      return {
        toolName: "browser.context.configure",
        category: "research",
        riskLevel: "caution",
        requiresApproval: true,
        description: "Configure browser context state",
        argSchema: {
          type: "object",
          properties: {
            viewport: {
              type: "object",
              properties: {
                width: { type: "integer" },
                height: { type: "integer" },
              },
            },
          },
          required: [],
        },
        examples: [],
        pack: "core",
        recommendedContexts: ["chat", "cowork", "code"],
        preferredForIntents: ["fetch_url", "web_lookup"],
      };
    }
    if (toolName === "local_business.research") {
      return {
        toolName: "local_business.research",
        category: "research",
        riskLevel: "safe",
        requiresApproval: false,
        description: "Build structured local-business contact research state",
        argSchema: {
          type: "object",
          properties: {
            objective: { type: "string" },
            citations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  url: { type: "string" },
                  snippet: { type: "string" },
                },
                required: ["url"],
              },
            },
          },
          required: ["objective"],
        },
        examples: [],
        pack: "core",
        recommendedContexts: ["cowork"],
        preferredForIntents: ["local_business_research", "contact_research", "research"],
        readOnly: true,
        deterministic: true,
      };
    }
    if (toolName === "time.now") {
      return {
        toolName: "time.now",
        category: "research",
        riskLevel: "safe",
        requiresApproval: false,
        description: "Current time",
        argSchema: {
          type: "object",
          properties: {},
          required: [],
        },
        examples: [],
        pack: "core",
        readOnly: true,
        deterministic: true,
      };
    }
    if (toolName === "session.status") {
      return {
        toolName: "session.status",
        category: "session",
        riskLevel: "safe",
        requiresApproval: false,
        description: "Read current session status",
        argSchema: {
          type: "object",
          properties: {},
          required: [],
        },
        examples: [],
        pack: "core",
        recommendedContexts: ["chat", "cowork", "code"],
        preferredForIntents: ["session_status", "planning"],
      };
    }
    if (toolName === "agent.fanout") {
      return {
        toolName: "agent.fanout",
        category: "session",
        riskLevel: "caution",
        requiresApproval: false,
        description: "Spawn up to 3 delegated subagents for independent subtasks",
        argSchema: {
          type: "object",
          properties: {
            subtasks: {
              type: "array",
              minItems: 1,
              maxItems: 3,
              items: {
                type: "object",
                properties: {
                  objective: { type: "string" },
                  label: { type: "string" },
                  expectedOutput: { type: "string" },
                },
                required: ["objective"],
              },
            },
          },
          required: ["subtasks"],
        },
        examples: [],
        pack: "core",
        recommendedContexts: ["cowork", "code"],
        preferredForIntents: ["parallel_subtasks", "delegation"],
      };
    }
    return {
      toolName: "browser.search",
      category: "research",
      riskLevel: "safe",
      requiresApproval: false,
      description: "Search",
      argSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
      examples: [],
      pack: "core",
    };
  });
}

export function createExecuteToolCallForTest(input: {
  invokeTool: (request: ToolInvokeRequest, options?: { executionFence?: () => void }) => Promise<ToolInvokeResult>;
  invokeToolWithEffectTruth?: NonNullable<ChatTurnAgentRunnerDeps["invokeToolWithEffectTruth"]>;
  toolNames: string[];
  storage?: ChatTurnAgentRunnerDeps["storage"];
  persistToolArtifact?: NonNullable<ChatTurnAgentRunnerDeps["persistToolArtifact"]>;
  invokeMcpTool?: NonNullable<ChatTurnAgentRunnerDeps["invokeMcpTool"]>;
  listMcpBrowserFallbackTargets?: NonNullable<ChatTurnAgentRunnerDeps["listMcpBrowserFallbackTargets"]>;
  recordRuntimeDecision?: NonNullable<ChatTurnAgentRunnerDeps["recordRuntimeDecision"]>;
  safeWriteFallbackDir?: string;
  evaluateToolAccess?: NonNullable<ChatTurnAgentRunnerDeps["evaluateToolAccess"]>;
}): (input: ExecuteToolCallInput) => Promise<ExecuteToolCallResult> {
  const orchestrator = new ChatTurnAgentRunner({
    storage: input.storage ?? (createMockStorage() as never),
    listToolCatalog: () => createToolCatalog(input.toolNames),
    createChatCompletion: async (): Promise<ChatCompletionResponse> => ({
      model: "glm-5",
      choices: [{ index: 0, message: { role: "assistant", content: "" } }],
    }),
    invokeTool: input.invokeTool,
    invokeToolWithEffectTruth: input.invokeToolWithEffectTruth,
    invokeMcpTool: input.invokeMcpTool,
    listMcpBrowserFallbackTargets: input.listMcpBrowserFallbackTargets,
    recordRuntimeDecision: input.recordRuntimeDecision,
    persistToolArtifact: input.persistToolArtifact,
    safeWriteFallbackDir: input.safeWriteFallbackDir,
    evaluateToolAccess: input.evaluateToolAccess,
  });
  const executeToolCall = (
    orchestrator as unknown as {
      executeToolCall(input: ExecuteToolCallInput): Promise<ExecuteToolCallResult>;
    }
  ).executeToolCall;
  return executeToolCall.bind(orchestrator);
}

export function toolCallCompletion(query: string): ChatCompletionResponse {
  return {
    model: "glm-5",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "browser_search",
                arguments: JSON.stringify({ query }),
              },
            },
          ],
        },
      },
    ],
  };
}
export function namedToolCallCompletion(toolName: string, args: Record<string, unknown>): ChatCompletionResponse {
  return {
    model: "glm-5",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: `call-${toolName.replace(/\./g, "-")}-1`,
              type: "function",
              function: {
                name: toolName.replace(/\./g, "_"),
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
      },
    ],
  };
}

export function navigateToolCallCompletion(args: Record<string, unknown>): ChatCompletionResponse {
  return {
    model: "glm-5",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call-nav-1",
              type: "function",
              function: {
                name: "browser_navigate",
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
      },
    ],
  };
}

export function extractToolCallCompletion(args: Record<string, unknown>): ChatCompletionResponse {
  return {
    model: "glm-5",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call-extract-1",
              type: "function",
              function: {
                name: "browser_extract",
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
      },
    ],
  };
}

export function httpGetToolCallCompletion(args: Record<string, unknown>): ChatCompletionResponse {
  return {
    model: "glm-5",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call-http-get-1",
              type: "function",
              function: {
                name: "http_get",
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
      },
    ],
  };
}

export function createMockStorage(): unknown {
  const traces = new Map<string, ChatTurnTraceRecord>();
  const toolRuns = new Map<string, ChatToolRunRecord>();
  const systemSettings = new Map<string, unknown>();
  return {
    chatTurnTraces: {
      get(turnId: string): ChatTurnTraceRecord {
        const current = traces.get(turnId);
        if (!current) {
          throw new NotFoundError(`chat turn trace ${turnId} not found`);
        }
        return current;
      },
      create(input: Omit<ChatTurnTraceRecord, "toolRuns" | "citations">): ChatTurnTraceRecord {
        const record: ChatTurnTraceRecord = {
          ...input,
          toolRuns: [],
          citations: [],
        };
        traces.set(record.turnId, record);
        return record;
      },
      patch(turnId: string, patch: Partial<ChatTurnTraceRecord>): ChatTurnTraceRecord {
        const current = traces.get(turnId);
        if (!current) {
          throw new Error(`trace ${turnId} missing`);
        }
        const next: ChatTurnTraceRecord = {
          ...current,
          ...patch,
        };
        traces.set(turnId, next);
        return next;
      },
    },
    chatToolRuns: {
      create(input: ChatToolRunRecord): ChatToolRunRecord {
        toolRuns.set(input.toolRunId, input);
        return input;
      },
      patch(toolRunId: string, patch: Partial<ChatToolRunRecord>): ChatToolRunRecord {
        const current = toolRuns.get(toolRunId);
        if (!current) {
          throw new Error(`tool run ${toolRunId} missing`);
        }
        const next = {
          ...current,
          ...patch,
        };
        toolRuns.set(toolRunId, next);
        return next;
      },
      listByTurn(turnId: string): ChatToolRunRecord[] {
        return [...toolRuns.values()].filter((item) => item.turnId === turnId);
      },
      listBySession(sessionId: string): ChatToolRunRecord[] {
        return [...toolRuns.values()].filter((item) => item.sessionId === sessionId);
      },
    },
    chatSessionProjects: {
      get: () => undefined,
    },
    // In-memory system_settings so P2-W3 decision-point reads (blocker-template
    // strictness, retry threshold) resolve against a real store in tests.
    systemSettings: {
      get<T = unknown>(key: string): { key: string; value: T; updatedAt: string } | undefined {
        if (!systemSettings.has(key)) {
          return undefined;
        }
        return { key, value: systemSettings.get(key) as T, updatedAt: "2026-03-22T12:00:00.000Z" };
      },
      set<T>(key: string, value: T): { key: string; value: T; updatedAt: string } {
        systemSettings.set(key, value);
        return { key, value, updatedAt: "2026-03-22T12:00:00.000Z" };
      },
    },
    _getTrace: (turnId: string) => traces.get(turnId),
    chatExecutionPlans: {
      listBySession: () => [],
    },
    chatInlineApprovals: {
      upsert: () => undefined,
    },
    approvals: {
      get: (approvalId: string) => ({
        approvalId,
        kind: "shell.exec",
        riskLevel: "danger",
        status: "pending",
        payload: {},
        preview: {},
        createdAt: "2026-03-22T12:00:00.000Z",
        expiresAt: "2026-03-22T12:15:00.000Z",
        explanationStatus: "not_requested",
      }),
    },
  };
}

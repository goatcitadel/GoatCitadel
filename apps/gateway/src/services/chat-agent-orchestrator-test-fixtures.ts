import type {
  ChatCompletionResponse,
  ChatToolRunRecord,
  ChatTurnTraceRecord,
  ToolCatalogEntry,
  ToolInvokeRequest,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import { NotFoundError } from "@goatcitadel/contracts";
import {
  ChatAgentOrchestrator,
  type ChatAgentOrchestratorDeps,
  type ChatAgentTurnInput,
} from "./chat-agent-orchestrator.js";

type ExecuteToolCallInput = {
  input: ChatAgentTurnInput;
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
};

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
    if (toolName === "shell.exec") {
      return {
        toolName: "shell.exec",
        category: "shell",
        riskLevel: "danger",
        requiresApproval: true,
        description: "Execute a shell command",
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
  invokeTool: (request: ToolInvokeRequest) => Promise<ToolInvokeResult>;
  toolNames: string[];
  storage?: ChatAgentOrchestratorDeps["storage"];
  persistToolArtifact?: NonNullable<ChatAgentOrchestratorDeps["persistToolArtifact"]>;
}): (input: ExecuteToolCallInput) => Promise<ExecuteToolCallResult> {
  const orchestrator = new ChatAgentOrchestrator({
    storage: input.storage ?? (createMockStorage() as never),
    listToolCatalog: () => createToolCatalog(input.toolNames),
    createChatCompletion: async (): Promise<ChatCompletionResponse> => ({
      model: "glm-5",
      choices: [{ index: 0, message: { role: "assistant", content: "" } }],
    }),
    invokeTool: input.invokeTool,
    persistToolArtifact: input.persistToolArtifact,
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

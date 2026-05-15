import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ToolInvokeRequest,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import {
  ChatAgentOrchestrator,
  type ChatAgentOrchestratorDeps,
  type ChatAgentTurnInput,
} from "./chat-agent-orchestrator.js";
import { createMockStorage, createToolCatalog } from "./chat-agent-orchestrator-test-fixtures.js";

describe("ChatAgentOrchestrator loop 24 coverage", () => {
  it("repairs content-filter interrupted direct completions through the repair pass", async () => {
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            finish_reason: "content_filter",
            message: {
              role: "assistant",
              content: "Partial filtered draft",
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "Repaired answer from the existing context.",
            },
          },
        ],
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => [],
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run(
      turnInput({
        content: "Draft a concise project status summary.",
        historyMessages: [{ role: "user", content: "Draft a concise project status summary." }],
      }),
    );

    expect(createChatCompletion).toHaveBeenCalledTimes(2);
    expect(result.assistantContent).toBe("Repaired answer from the existing context.");
    expect(result.turnTrace.completion).toMatchObject({
      status: "complete",
      repaired: true,
      repair: expect.objectContaining({
        applied: true,
        kind: "incomplete_truncated_completion",
        source: "orchestrator",
      }),
    });
  });

  it("filters denied and failing tool-access checks out of the provider tool schema", async () => {
    let capturedRequest: ChatCompletionRequest | undefined;
    const createChatCompletion = vi.fn(async (request: ChatCompletionRequest): Promise<ChatCompletionResponse> => {
      capturedRequest = request;
      return completion("Tool access was filtered.");
    });
    const evaluateToolAccess = vi.fn((input: { toolName: string }) => {
      if (input.toolName === "browser.search") {
        throw new Error("policy service unavailable");
      }
      return { allowed: input.toolName !== "memory.search" };
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["session.status", "memory.search", "browser.search"]),
      createChatCompletion,
      invokeTool: vi.fn(),
      evaluateToolAccess,
    });

    const result = await orchestrator.run(
      turnInput({
        content: "Use `session.status`, `memory.search`, and `browser.search` if available, then summarize readiness.",
        memoryMode: "on",
        webMode: "auto",
        historyMessages: [
          {
            role: "user",
            content:
              "Use `session.status`, `memory.search`, and `browser.search` if available, then summarize readiness.",
          },
        ],
      }),
    );

    const toolNames = extractRequestToolNames(capturedRequest);
    expect(result.assistantContent).toContain("Tool access was filtered");
    expect(evaluateToolAccess).toHaveBeenCalledWith(expect.objectContaining({ toolName: "memory.search" }));
    expect(evaluateToolAccess).toHaveBeenCalledWith(expect.objectContaining({ toolName: "browser.search" }));
    expect(toolNames).toContain("session_status");
    expect(toolNames).not.toContain("memory_search");
    expect(toolNames).not.toContain("browser_search");
  });

  it("blocks delegated non-code Prompt Lab local file calls before runtime invocation", async () => {
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>();
    const executeToolCall = createExecuteToolCall({ invokeTool });
    const prompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: implicit-tools",
      "",
      "## User Task",
      "Delegated role: Researcher",
      "",
      "Parent objective: Plan a volunteer orientation.",
      "",
      "Current step objective: Draft the public-facing agenda.",
      "",
      "Suggested tools: file.find",
      "",
      "Produce only the delegated output.",
    ].join("\n");

    const result = await executeToolCall({
      input: turnInput({
        content: prompt,
        mode: "cowork",
        normalizationProfile: "prompt_pack_harness",
        historyMessages: [{ role: "user", content: prompt }],
      }),
      turnId: "turn-delegated-local-suppressed",
      toolName: "file.find",
      rawArgs: { path: ".", pattern: "orientation" },
    });

    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.record).toMatchObject({
      toolName: "file.find",
      status: "blocked",
      error:
        "execution skipped: local file/code tools were suppressed because this non-code Prompt Lab step does not ask for repository inspection",
    });
  });

  it("blocks browser search calls when a local project prompt has no explicit web intent", async () => {
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>();
    const executeToolCall = createExecuteToolCall({ invokeTool });

    const result = await executeToolCall({
      input: turnInput({
        content: "Inspect `apps/gateway/src/services/chat-agent-orchestrator.ts` and explain the local code path.",
        mode: "code",
        webMode: "auto",
        historyMessages: [
          {
            role: "user",
            content: "Inspect `apps/gateway/src/services/chat-agent-orchestrator.ts` and explain the local code path.",
          },
        ],
      }),
      turnId: "turn-local-browser-suppressed",
      toolName: "browser.search",
      rawArgs: { query: "chat agent orchestrator" },
      localFileIntent: true,
    });

    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.record).toMatchObject({
      toolName: "browser.search",
      status: "blocked",
      error: "execution skipped: browser.search was suppressed because the prompt targets local files/project context",
    });
  });

  it("leaves approval expiry undefined when both result and approval storage lookup are unavailable", async () => {
    const storage = createMockStorage() as {
      approvals: { get: (approvalId: string) => unknown };
    };
    storage.approvals.get = () => {
      throw new Error("approval row missing");
    };
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "approval_required",
      policyReason: "approval required",
      auditEventId: "audit-missing-approval-expiry",
      approvalId: "approval-missing-expiry",
    });
    const executeToolCall = createExecuteToolCall({ storage: storage as never, invokeTool });

    const result = await executeToolCall({
      input: turnInput({
        content: "Run a shell check after approval.",
        mode: "code",
      }),
      turnId: "turn-missing-approval-expiry",
      toolName: "shell.exec",
      rawArgs: { command: "pnpm --version" },
    });

    expect(result.record).toMatchObject({
      status: "approval_required",
      approvalId: "approval-missing-expiry",
    });
    expect(result.approvalExpiresAt).toBeUndefined();
  });

  it("repairs env-loaded prompt-pack source-label prompts into concrete test scaffolding", async () => {
    const prompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: implicit-tools",
      "",
      "## User Task",
      "Inspect the repo if needed and propose the exact minimal automated test that proves an env-loaded prompt pack preserves its source label.",
      "",
      "Answer contract:",
      "- Include `Setup`, `Act`, `Assert`, and `Failure signature` details.",
    ].join("\n");
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(completion("Need answer with observed/inferred maybe incomplete."));
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockImplementation(async (request) => ({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: `audit-env-source-${String(request.args.path).replace(/[^a-z0-9]+/gi, "-")}`,
        result:
          request.args.path === "apps/gateway/src/services/prompt-pack-service.parser-report.test.ts"
            ? {
                path: request.args.path,
                content: "describe('parsePromptPackTests', () => { it('loads packs', () => undefined); });",
              }
            : {
                path: request.args.path,
                content:
                  "class PromptPackService { ensurePromptPackLoaded() { return process.env.GOATCITADEL_PROMPT_PACK_PATH; } }",
              },
      }));
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range", "code.search_files"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run(
      turnInput({
        content: prompt,
        mode: "code",
        providerId: "openai",
        model: "gpt-5.4",
        thinkingLevel: "extended",
        normalizationProfile: "prompt_pack_harness",
        historyMessages: [{ role: "user", content: prompt }],
      }),
    );

    expect(result.assistantContent).toContain("preserves the real env prompt-pack source label");
    expect(result.assistantContent).toContain("GOATCITADEL_PROMPT_PACK_PATH");
    expect(result.assistantContent).toContain("replacePackTests");
    expect(result.assistantContent).toContain("Exact files used:");
    expect(result.assistantContent).toContain("apps/gateway/src/services/prompt-pack-service.parser-report.test.ts");
    expect(result.assistantContent).toContain("apps/gateway/src/services/prompt-pack-service.ts");
  });

  it("repairs expanded-pack judge-default prompts into concrete scoring test scaffolding", async () => {
    const prompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: implicit-tools",
      "",
      "## User Task",
      "Inspect the repo if needed and propose the exact minimal automated test that proves judge defaults use the expanded pack instead of the frozen baseline.",
      "",
      "Answer contract:",
      "- Include `Setup`, `Act`, `Assert`, and `Failure signature` details.",
    ].join("\n");
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(completion("Need answer with observed/inferred maybe incomplete."));
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockImplementation(async (request) => ({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: `audit-judge-defaults-${String(request.args.path).replace(/[^a-z0-9]+/gi, "-")}`,
        result:
          request.args.path === "apps/gateway/src/services/prompt-pack-service.scoring.test.ts"
            ? {
                path: request.args.path,
                content: "describe('autoScorePromptPackTest', () => { it('scores packs', () => undefined); });",
              }
            : {
                path: request.args.path,
                content:
                  "class PromptPackService { autoScorePromptPackTest() { return getPromptJudgeModelDefaults(); } }",
              },
      }));
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range", "code.search_files"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run(
      turnInput({
        content: prompt,
        mode: "code",
        providerId: "openai",
        model: "gpt-5.4",
        thinkingLevel: "extended",
        normalizationProfile: "prompt_pack_harness",
        historyMessages: [{ role: "user", content: prompt }],
      }),
    );

    expect(result.assistantContent).toContain("scores the expanded pack with expanded judge defaults");
    expect(result.assistantContent).toContain("getPromptJudgeModelDefaults");
    expect(result.assistantContent).toContain('judgeProviderId: "openai-codex"');
    expect(result.assistantContent).toContain("apps/gateway/src/services/prompt-pack-service.scoring.test.ts");
    expect(result.assistantContent).toContain("apps/gateway/src/services/prompt-pack-service.ts");
  });

  it("repairs typed wake outcome prompts from concrete contract, producer, consumer, and validation reads", async () => {
    const prompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: implicit-tools",
      "",
      "## User Task",
      "Use file or code tools to inspect typed wake outcomes. Identify the exact patch points, name the contract file, producer call sites, consumer/status shaping, and validation step.",
      "",
      "Answer contract:",
      "- Cite the exact files used.",
      "- Name the contract file, producer call sites, consumer/status shaping, and validation step.",
    ].join("\n");
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(completion("Need answer with observed/inferred maybe incomplete."));
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockImplementation(async (request) => ({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: `audit-typed-wake-${String(request.args.path).replace(/[^a-z0-9]+/gi, "-")}`,
        result: {
          path: request.args.path,
          content: typedWakeFixtureContent(String(request.args.path)),
        },
      }));
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range", "code.search_files"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run(
      turnInput({
        content: prompt,
        mode: "code",
        providerId: "openai",
        model: "gpt-5.4",
        thinkingLevel: "extended",
        normalizationProfile: "prompt_pack_harness",
        historyMessages: [{ role: "user", content: prompt }],
      }),
    );

    expect(result.assistantContent).toContain("## Contract file");
    expect(result.assistantContent).toContain("packages/contracts/src/durable.ts");
    expect(result.assistantContent).toContain("wakeDurableRun(...)");
    expect(result.assistantContent).toContain("handleWakeEffect(...)");
    expect(result.assistantContent).toContain("approval-resolution-effects-service.test.ts");
    expect(result.assistantContent).toContain("## Validation step");
  });
});

function createExecuteToolCall(input: {
  storage?: ChatAgentOrchestratorDeps["storage"];
  invokeTool: (request: ToolInvokeRequest) => Promise<ToolInvokeResult>;
}) {
  const orchestrator = new ChatAgentOrchestrator({
    storage: input.storage ?? (createMockStorage() as never),
    listToolCatalog: () =>
      createToolCatalog(["browser.search", "file.find", "shell.exec", "session.status", "memory.search"]),
    createChatCompletion: vi.fn<() => Promise<ChatCompletionResponse>>(),
    invokeTool: input.invokeTool,
  });
  return (
    orchestrator as unknown as {
      executeToolCall(input: {
        input: ChatAgentTurnInput;
        turnId: string;
        toolName: string;
        rawArgs: Record<string, unknown>;
        localFileIntent?: boolean;
      }): Promise<{
        record: {
          toolName: string;
          status: string;
          error?: string;
          approvalId?: string;
        };
        approvalExpiresAt?: string;
      }>;
    }
  ).executeToolCall.bind(orchestrator);
}

function turnInput(overrides: Partial<ChatAgentTurnInput> = {}): ChatAgentTurnInput {
  const content = overrides.content ?? "Answer directly.";
  return {
    sessionId: "sess-loop24",
    turnId: randomUUID(),
    userMessageId: "msg-loop24",
    content,
    mode: "chat",
    providerId: "glm",
    model: "glm-5",
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "standard",
    toolAutonomy: "safe_auto",
    historyMessages: [{ role: "user", content }],
    ...overrides,
  };
}

function completion(content: string): ChatCompletionResponse {
  return {
    model: "glm-5",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
        },
      },
    ],
  };
}

function extractRequestToolNames(request: ChatCompletionRequest | undefined): string[] {
  return (request?.tools ?? [])
    .map((tool) => {
      const record = tool as { function?: { name?: unknown } };
      return typeof record.function?.name === "string" ? record.function.name : undefined;
    })
    .filter((name): name is string => Boolean(name));
}

function typedWakeFixtureContent(path: string): string {
  if (path === "packages/contracts/src/durable.ts") {
    return "export type DurableWakeOutcome = 'woke' | 'skipped_not_waiting' | 'failed';\nexport interface DurableWakeResult { outcome: DurableWakeOutcome; }";
  }
  if (path === "apps/gateway/src/services/durable-run-service.ts") {
    return "export class DurableRunService { public async wakeDurableRun(): Promise<DurableWakeResult> { return { outcome: 'woke' }; } }";
  }
  if (path === "apps/gateway/src/services/approval-resolution-effects-service.ts") {
    return "export class ApprovalEffectsService { private async handleWakeEffect() { return buildRecoveredWakeResult(); } }";
  }
  if (path === "apps/gateway/src/services/durable-run-service.test.ts") {
    return "it('covers wakeDurableRun outcomes', async () => { await service.wakeDurableRun('run-1'); });";
  }
  if (path === "apps/gateway/src/services/approval-resolution-effects-service.test.ts") {
    return "it('handles skipped_not_waiting and woke outcomes', async () => { await service.handleWakeEffect(); });";
  }
  return "";
}

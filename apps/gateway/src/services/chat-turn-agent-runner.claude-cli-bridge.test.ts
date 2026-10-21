import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ChatStreamChunkDraft,
  ChatToolRunRecord,
  LlmConfigFile,
  ToolInvokeRequest,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FAKE_CLAUDE_CLI_NODE_PATH,
  FAKE_CLAUDE_CLI_STUB_PATH,
  createFakeClaudeCliHarness,
  createFakeModelUsageAccounting,
  textStepScript,
  toolStepScript,
  type FakeClaudeCliHarness,
  type FakeClaudeCliScript,
} from "../test/claude-code-cli-fake-spawn.js";
import { createNoopSecretStore } from "../test/llm-fixtures.js";
import type { ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";
import {
  EffectAwareChatTurnAgentRunner as ChatTurnAgentRunner,
  createMockStorage,
  createToolCatalog,
} from "./chat-turn-agent-runner-test-fixtures.js";
import { buildPersistedToolContinuationCallId } from "./chat-tool-result-projection.js";
import { LlmService } from "./llm-service.js";

/**
 * Step mode end to end: the real runner and LlmService drive a fake `claude -p`.
 * Each CLI step stops at tool_use; the runner runs the call through its own
 * governed path and starts the next step with the result rendered into stdin.
 */

const WORKSPACE_ROOT = "/goatcitadel-workspace";
const REPORT_PROMPT = "Write a short report on full stack web languages and then put it into a pdf.";
const REPORT_PATH = `${WORKSPACE_ROOT}/goatcitadel_out/full-stack-languages.pdf`;
const DOWNLOAD_LINK = "/api/v1/files/download?relativePath=goatcitadel_out%2Ffull-stack-languages.pdf";
const DOC_ARGS = {
  path: "./workspace/goatcitadel_out/full-stack-languages.pdf",
  format: "pdf",
  title: "Full Stack Languages",
  sections: [{ heading: "Languages", bullets: ["TypeScript leads for full stack web work."] }],
};
const docCall = (id: string) => ({ id, name: "documents_create", input: DOC_ARGS });

const config: LlmConfigFile = {
  activeProviderId: "claude-code-cli",
  activeModel: "claude-sonnet-5-5",
  providers: [
    {
      providerId: "claude-code-cli",
      label: "Claude Code CLI (local login)",
      baseUrl: "https://api.anthropic.com/v1",
      apiStyle: "claude-code-cli",
      defaultModel: "claude-sonnet-5-5",
    },
  ],
};

const executedDocument = async (request: ToolInvokeRequest): Promise<ToolInvokeResult> => ({
  outcome: "executed",
  policyReason: "allowed",
  auditEventId: "audit-doc-1",
  result: { path: REPORT_PATH, bytesWritten: 4_096, format: "pdf", title: request.args.title },
});

describe("ChatTurnAgentRunner with the Claude Code CLI tool bridge", () => {
  let scratchRoot: string;

  beforeEach(() => {
    scratchRoot = mkdtempSync(path.join(os.tmpdir(), "gc-runner-cli-bridge-test-"));
  });

  afterEach(() => {
    rmSync(scratchRoot, { recursive: true, force: true });
  });

  function setup(input: {
    scripts: FakeClaudeCliScript[];
    invokeTool: (request: ToolInvokeRequest) => Promise<ToolInvokeResult>;
    toolNames?: string[];
    storage?: ReturnType<typeof createMockStorage>;
  }) {
    const harness = createFakeClaudeCliHarness(input.scripts);
    const service = new LlmService(
      config,
      { PATH: "C:\\Windows", USERPROFILE: "C:\\Users\\op" },
      {
        secretStore: createNoopSecretStore(),
        enforceNetworkAllowlist: false,
        modelUsageAccounting: createFakeModelUsageAccounting().service,
        claudeCliToolBridgeEnabled: () => true,
        claudeCli: {
          spawn: harness.spawn,
          killTree: harness.killTree,
          readiness: harness.readiness,
          resolveInvocation: () => ({ command: "C:\\Users\\op\\.local\\bin\\claude.exe", prefixArgs: [] }),
          scratchRoot,
          toolBridge: { stubPath: () => FAKE_CLAUDE_CLI_STUB_PATH, nodePath: FAKE_CLAUDE_CLI_NODE_PATH },
        },
      },
    );
    const storage = input.storage ?? createMockStorage();
    const invokeTool = vi.fn(input.invokeTool);
    const runner = new ChatTurnAgentRunner({
      storage: storage as never,
      listToolCatalog: () => createToolCatalog(input.toolNames ?? ["documents.create"]),
      createChatCompletion: (request, attribution) => service.chatCompletions(request, attribution),
      createChatCompletionStream: async (request, attribution) => service.chatCompletionsStream(request, attribution),
      describeProviderToolSupport: (providerId) => service.describeProviderToolSupport(providerId),
      invokeTool,
      workspaceFileRootDir: WORKSPACE_ROOT,
    });
    return { harness, runner, storage, invokeTool };
  }

  it("two-step turn executes documents.create through invokeTool", async () => {
    const { harness, runner, storage, invokeTool } = setup({
      scripts: [toolStepScript(undefined, [docCall("toolu_doc")]), textStepScript("Your report is ready as a PDF.")],
      invokeTool: executedDocument,
    });
    const input = turnInput({ content: REPORT_PROMPT });

    const { chunks, result } = await collectTurn(runner, input);

    expect(invokeTool.mock.calls.map(([request]) => request.toolName)).toEqual(["documents.create"]);
    expect(invokeTool.mock.calls[0]?.[0].args).toMatchObject({ format: "pdf", title: "Full Stack Languages" });
    const [run] = listToolRuns(storage, input.turnId);
    expect(run).toMatchObject({ toolName: "documents.create", status: "executed" });
    expect(Number((run?.result as { bytesWritten?: number } | undefined)?.bytesWritten)).toBeGreaterThan(0);
    expect(chunks.some((chunk) => chunk.type === "tool_start")).toBe(true);
    expect(chunks.some((chunk) => chunk.type === "tool_result")).toBe(true);

    expect(harness.spawns).toHaveLength(2);
    expectBridged(harness);
    const step2 = renderedStdin(harness, 1);
    expect(step2).toContain("[Assistant tool call toolu_doc: documents_create]");
    expect(step2).toContain("[Tool result toolu_doc]");
    expect(step2).toContain('"bytesWritten":4096');

    expect(result.turnTrace.status).toBe("completed");
    expect(result.turnTrace.failure).toBeUndefined();
    expect(result.assistantContent).toContain("Your report is ready as a PDF.");
    expect(result.assistantContent).toContain(DOWNLOAD_LINK);
    expect(result.assistantContent).not.toContain("No file was created");
    expect(readdirSync(scratchRoot)).toEqual([]);
  });

  it("a policy-denied tool returns blocked to step 2", async () => {
    const { harness, runner, storage } = setup({
      scripts: [
        toolStepScript(undefined, [docCall("toolu_denied")]),
        textStepScript("Policy blocked the document, so here is the report in chat."),
      ],
      invokeTool: async () => ({
        outcome: "blocked",
        policyReason: "documents.create is denied by the workspace policy",
        auditEventId: "audit-doc-denied",
      }),
    });
    const input = turnInput({ content: REPORT_PROMPT });

    await collectTurn(runner, input);

    const [run] = listToolRuns(storage, input.turnId);
    expect(run).toMatchObject({ toolName: "documents.create", status: "blocked" });
    expect(harness.spawns).toHaveLength(2);
    const step2 = renderedStdin(harness, 1);
    // The runner's own blocked payload for any provider: the policy reason as the error.
    expect(step2).toContain(
      '[Tool result toolu_denied]\n{"error":"documents.create is denied by the workspace policy"',
    );
  });

  it("an approval-required tool ends the turn waiting_for_approval and the durable resume renders the continuation record", async () => {
    const storage = createMockStorage();
    const first = setup({
      storage,
      scripts: [toolStepScript(undefined, [docCall("toolu_approval")])],
      invokeTool: async () => ({
        outcome: "approval_required",
        policyReason: "documents.create needs operator approval",
        auditEventId: "audit-doc-approval",
        approvalId: "approval-doc-1",
      }),
    });
    const input = turnInput({ content: REPORT_PROMPT });

    const waiting = await collectTurn(first.runner, input);

    expect(waiting.result.turnTrace.status).toBe("waiting_for_approval");
    expect(waiting.result.requiresApproval).toMatchObject({ approvalId: "approval-doc-1" });
    expect(first.harness.spawns).toHaveLength(1);
    const [pending] = listToolRuns(storage, input.turnId);
    expect(pending).toMatchObject({ status: "approval_required", approvalId: "approval-doc-1" });

    // The approval owner settles the row; durable execution then re-enters the same turn.
    const settled = (storage as unknown as MockToolRunStorage).chatToolRuns.patch(pending!.toolRunId, {
      status: "executed",
      result: { path: REPORT_PATH, bytesWritten: 4_096, format: "pdf", title: "Full Stack Languages" },
      finishedAt: new Date().toISOString(),
    });
    const resumed = setup({
      storage,
      scripts: [textStepScript("Your approved report is ready as a PDF.")],
      invokeTool: executedDocument,
    });

    const result = await resumed.runner.run(input);

    const continuationId = buildPersistedToolContinuationCallId(settled);
    expect(continuationId).toMatch(/^resume_[0-9a-f]{24}$/);
    expect(resumed.harness.spawns).toHaveLength(1);
    expectBridged(resumed.harness);
    const resumeStdin = renderedStdin(resumed.harness, 0);
    expect(resumeStdin).toContain(`[Assistant tool call ${continuationId}: documents_create]`);
    expect(resumeStdin).toContain(`[Tool result ${continuationId}]`);
    expect(resumeStdin).toContain('"bytesWritten":4096');
    expect(resumeStdin).not.toContain("toolu_approval");
    expect(resumed.invokeTool).not.toHaveBeenCalled();
    expect(result.turnTrace.status).toBe("completed");
    expect(result.assistantContent).toContain(DOWNLOAD_LINK);
  });

  it("maxToolLoops exhausted stops spawning the CLI", async () => {
    let step = 0;
    const statusStep: FakeClaudeCliScript = (child, spawned) => {
      step += 1;
      toolStepScript(undefined, [{ id: `toolu_status_${step}`, name: "session_status", input: { probe: step } }])(
        child,
        spawned,
      );
    };
    const { harness, runner, storage, invokeTool } = setup({
      toolNames: ["session.status"],
      // A model that would keep calling tools forever: only the loop budget ends it.
      scripts: [statusStep, statusStep, textStepScript("session.status stayed healthy."), statusStep, statusStep],
      invokeTool: async () => ({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-status",
        result: { status: "healthy" },
      }),
    });
    const input = turnInput({ content: "Use session.status again and again until it changes." });

    const result = await runner.run(input);

    // webMode "off" gives this turn two tool loops. The runner then asks for one
    // tool-free answer, which is an unbridged step, and spawns nothing after it.
    expect(harness.spawns).toHaveLength(3);
    expect(harness.spawns.map((spawned) => spawned.args.includes("--mcp-config"))).toEqual([true, true, false]);
    const synthesis = harness.spawns[2];
    expect(synthesis?.args).toContain("--safe-mode");
    expect(synthesis?.toolsFileAtSpawn).toBeUndefined();
    expect(invokeTool).toHaveBeenCalledTimes(2);
    expect(listToolRuns(storage, input.turnId).map((run) => run.status)).toEqual(["executed", "executed"]);
    expect(result.turnTrace.status).toBe("completed");
    expect(result.assistantContent).toContain("session.status stayed healthy.");
  });

  it("abort between steps spawns no further CLI", async () => {
    const controller = new AbortController();
    const { harness, runner, invokeTool } = setup({
      scripts: [toolStepScript(undefined, [docCall("toolu_abort")]), textStepScript("never sent")],
      invokeTool: async (request) => {
        const executed = await executedDocument(request);
        controller.abort();
        return executed;
      },
    });
    const input = turnInput({ content: REPORT_PROMPT, signal: controller.signal });

    const result = await runner.run(input);

    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(harness.spawns).toHaveLength(1);
    expect(harness.killTree).toHaveBeenCalledTimes(1);
    expect(result.turnTrace.status).toBe("cancelled");
    expect(readdirSync(scratchRoot)).toEqual([]);
  });
});

type MockToolRunStorage = {
  chatToolRuns: {
    listByTurn(turnId: string): ChatToolRunRecord[];
    patch(toolRunId: string, patch: Partial<ChatToolRunRecord>): ChatToolRunRecord;
  };
};

function listToolRuns(storage: unknown, turnId: string): ChatToolRunRecord[] {
  return (storage as MockToolRunStorage).chatToolRuns.listByTurn(turnId);
}

/** Every step the runner offered tools to is bridged: MCP config in, safe mode out. */
function expectBridged(harness: FakeClaudeCliHarness): void {
  for (const spawned of harness.spawns) {
    expect(spawned.args).toContain("--mcp-config");
    expect(spawned.args).not.toContain("--safe-mode");
    expect(spawned.toolsFileAtSpawn).toMatchObject({ tools: [expect.objectContaining({ name: expect.any(String) })] });
  }
}

/** The step's stdin user message, text blocks joined, so assertions read like the CLI's view. */
function renderedStdin(harness: FakeClaudeCliHarness, index: number): string {
  const raw = harness.spawns[index]?.stdin() ?? "";
  const message = JSON.parse(raw) as { message: { content: Array<{ text: string }> } };
  return message.message.content.map((block) => block.text).join("\n\n");
}

async function collectTurn(runner: ChatTurnAgentRunner, input: ChatTurnAgentRunnerInput) {
  const chunks: ChatStreamChunkDraft[] = [];
  for await (const chunk of runner.runStream(input)) chunks.push(chunk);
  const trace = chunks.filter((chunk) => chunk.type === "trace_update").at(-1)?.trace;
  const approval = chunks.find((chunk) => chunk.type === "approval_required")?.approval;
  if (!trace) throw new Error("turn ended without a trace");
  return {
    chunks,
    result: {
      turnTrace: trace,
      assistantContent: chunks.filter((chunk) => chunk.type === "message_done").at(-1)?.content ?? "",
      requiresApproval: approval ? { approvalId: approval.approvalId } : undefined,
    },
  };
}

function turnInput(overrides: Partial<ChatTurnAgentRunnerInput> = {}): ChatTurnAgentRunnerInput {
  const content = overrides.content ?? "Answer directly.";
  const base: ChatTurnAgentRunnerInput = {
    sessionId: "sess-cli-bridge",
    turnId: randomUUID(),
    userMessageId: "msg-cli-bridge",
    content,
    mode: "chat",
    providerId: "claude-code-cli",
    model: "claude-sonnet-5-5",
    webMode: "off",
    memoryMode: "off",
    retrievalMode: "standard",
    thinkingLevel: "standard",
    toolAutonomy: "safe_auto",
    historyMessages: [{ role: "user", content }],
  };
  return { ...base, ...overrides } as ChatTurnAgentRunnerInput;
}

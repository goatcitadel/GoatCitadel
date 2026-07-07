import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionResponse, ToolInvokeRequest, ToolInvokeResult } from "@goatcitadel/contracts";
import { ChatTurnAgentRunner, type ChatTurnAgentRunnerResult } from "./chat-turn-agent-runner.js";
import { createMockStorage, createToolCatalog } from "./chat-turn-agent-runner-test-fixtures.js";

describe("ChatTurnAgentRunner loop40 durable orchestration eval-integrity behavior", () => {
  it.each([
    {
      name: "expired lease recovery",
      task: "Inspect the repo if needed and propose the exact minimal automated test that proves an expired durable-run lease can be recovered by a different worker while a still-active leased run is left alone.",
    },
    {
      name: "lease release transitions",
      task: "Inspect the repo if needed and propose the exact minimal automated test that proves waiting, paused, and terminal durable-run transitions release any active lease.",
    },
  ])("passes the model's durable-run answer through verbatim for $name", async ({ task }) => {
    const modelAnswer =
      "Need answer with observed/inferred maybe incomplete. Best next move: retry file reads with a narrower query.";
    const { result } = await runDurablePromptLabTurn({
      sessionId: `sess-loop40-${task.includes("expired") ? "lease-recovery" : "lease-release"}`,
      task,
      answerContract: [
        "Answer contract:",
        "- Name the target test file or suite.",
        "- Provide `Setup`, `Act`, `Assert`, and `Failure signature` bullets.",
      ],
      modelAnswer,
    });

    expect(result.assistantContent).toBe(modelAnswer);
    expect(result.assistantContent).not.toContain("Exact files used:");
    expect(result.turnTrace.status).toBe("completed");
  });

  it("runs no forced tool calls and appends no patch-plan scaffold when the model makes no tool calls", async () => {
    const modelAnswer = "A generic patch plan should add a lease table and retry later.";
    const { result, invokeTool } = await runDurablePromptLabTurn({
      sessionId: "sess-loop40-persisted-durable-leases",
      task: "Inspect the repo if needed and identify the exact patch points for persisted leases across durable-run storage, claim logic, and recovery logic. Concretely read `packages/contracts/src/durable.ts`, `packages/storage/src/durable-run-repo.ts`, `apps/gateway/src/services/durable-run-service.ts`, and `apps/gateway/src/services/durable-run-service.test.ts`. Include schema or storage changes, claim path changes, recovery path changes, heartbeat path changes, migration note, and a two-worker validation step.",
      answerContract: [
        "Answer contract:",
        "- Cite the exact files whose contents you concretely read.",
        "- Keep the patch plan grouped by storage, claim, recovery, heartbeat, migration, and validation.",
      ],
      modelAnswer,
    });

    expect(result.assistantContent).toBe(modelAnswer);
    expect(result.assistantContent).not.toContain("## Schema or storage changes");
    expect(result.assistantContent).not.toContain("## Claim path changes");
    expect(result.assistantContent).not.toContain("## Recovery path changes");
    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.turnTrace.toolRuns).toHaveLength(0);
    expect(result.turnTrace.status).toBe("completed");
  });
});

async function runDurablePromptLabTurn(input: {
  sessionId: string;
  task: string;
  answerContract: string[];
  modelAnswer: string;
}): Promise<{ result: ChatTurnAgentRunnerResult; invokeTool: ReturnType<typeof createDurableEvidenceTool> }> {
  const wrappedPrompt = [
    "## Prompt Lab Run Contract",
    "- Mode: code",
    "- Tool tier: implicit-tools",
    "- This is a repo-grounded code evaluation. Inspect the repository before answering whenever current repo state matters.",
    "- Repo inspection assist: enabled.",
    "- Required tool families: file/code tools",
    "",
    "## User Task",
    input.task,
    "",
    ...input.answerContract,
  ].join("\n");
  const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
    model: "gpt-5.4",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: input.modelAnswer,
        },
      },
    ],
  });
  const invokeTool = createDurableEvidenceTool();
  const orchestrator = new ChatTurnAgentRunner({
    storage: createMockStorage() as never,
    listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
    createChatCompletion,
    invokeTool,
  });

  const result = await orchestrator.run({
    sessionId: input.sessionId,
    turnId: randomUUID(),
    userMessageId: `${input.sessionId}-message`,
    content: wrappedPrompt,
    mode: "code",
    providerId: "openai",
    model: "gpt-5.4",
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "extended",
    toolAutonomy: "safe_auto",
    normalizationProfile: "prompt_pack_harness",
    historyMessages: [{ role: "user", content: wrappedPrompt }],
  });

  return { result, invokeTool };
}

function createDurableEvidenceTool() {
  return vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>(async (request) => {
    if (request.toolName === "code.search_files") {
      return {
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: `audit-loop40-search-${String(request.args.query ?? "query").replace(/[^a-z0-9]+/gi, "-")}`,
        result: {
          matches: [
            { path: "packages/contracts/src/durable.ts", name: "durable.ts", type: "file" },
            {
              path: "apps/gateway/src/services/durable-run-service.test.ts",
              name: "durable-run-service.test.ts",
              type: "file",
            },
            { path: "apps/gateway/src/services/durable-run-service.ts", name: "durable-run-service.ts", type: "file" },
            { path: "packages/storage/src/durable-run-repo.ts", name: "durable-run-repo.ts", type: "file" },
          ],
        },
      };
    }

    const requestedPath = String(request.args.path ?? "");
    return {
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: `audit-loop40-read-${requestedPath.replace(/[^a-z0-9]+/gi, "-")}`,
      result: {
        path: requestedPath,
        startLine: 1,
        endLine: 120,
        content: durableEvidenceContent(requestedPath),
      },
    };
  });
}

function durableEvidenceContent(path: string): string {
  if (path === "packages/contracts/src/durable.ts") {
    return [
      "export interface DurableRunRecord {",
      "  leaseOwnerId?: string;",
      "  leaseHeartbeatAt?: string;",
      "  leaseExpiresAt?: string;",
      "}",
    ].join("\n");
  }
  if (path === "packages/storage/src/durable-run-repo.ts") {
    return [
      "export class DurableRunRepository {",
      "  public tryClaimQueuedRun(input: { runId: string; workerId: string }): DurableRunRecord | undefined {",
      "    return this.compareAndSwapRun(input.runId, { status: 'running', leaseOwnerId: input.workerId });",
      "  }",
      "  public listExpiredRunningRunIds(nowIso: string): string[] { return this.findExpired(nowIso); }",
      "  public renewLease(input: { runId: string; workerId: string }): DurableRunRecord | undefined {",
      "    return this.renewWhenOwnerMatches(input.runId, input.workerId);",
      "  }",
      "}",
    ].join("\n");
  }
  if (path === "apps/gateway/src/services/durable-run-service.ts") {
    return [
      "export class DurableRunService {",
      "  private async reconcileRecoverableRuns() { this.storage.durableRuns.listExpiredRunningRunIds(new Date().toISOString()); }",
      "  private async claimNextQueuedRun() { return this.storage.durableRuns.tryClaimQueuedRun({ runId: 'run-1', workerId: this.workerId }); }",
      "  private hasFutureRetryGate(runId: string, nowIso: string): boolean { return Boolean(runId && nowIso); }",
      "  private async executeWithLeaseHeartbeat(runId: string) { return this.storage.durableRuns.renewLease({ runId, workerId: this.workerId }); }",
      "  public async wakeDurableRun(runId: string) { return this.clearLeaseOnWaitingWake(runId); }",
      "  public async pauseDurableRun(runId: string) { return this.clearLeaseOnPause(runId); }",
      "  public async cancelDurableRun(runId: string) { return this.clearLeaseOnTerminal(runId); }",
      "}",
    ].join("\n");
  }
  return [
    "describe('DurableRunService', () => {",
    "  it('does not clobber a run after lease ownership moves to another worker', async () => {});",
    "  it('recovers an expired running lease while preserving a still-active leased run', async () => {});",
    "  it('clears lease fields when waiting, paused, or terminal transitions occur', async () => {});",
    "});",
  ].join("\n");
}

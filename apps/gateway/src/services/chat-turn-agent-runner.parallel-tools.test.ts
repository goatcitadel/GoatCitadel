import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionRequest, ChatCompletionResponse, ToolInvokeResult } from "@goatcitadel/contracts";
import type { ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";
import {
  EffectAwareChatTurnAgentRunner as ChatTurnAgentRunner,
  createMockStorage,
  createToolCatalog,
} from "./chat-turn-agent-runner-test-fixtures.js";

interface ToolTiming {
  toolName: string;
  probe: number;
  startedAt: number;
  finishedAt: number;
}

// memory.read is registry-declared readOnly + safe + approval-free, takes no
// required args (so no local-path preflight), and routes through invokeTool —
// distinct `probe` args keep the loop guard's repeated-same-call detector out
// of the way.
const READ_ONLY_BATCH = ["memory.read", "memory.read", "memory.read"] as const;

function toolCallsResponse(toolNames: readonly string[]): ChatCompletionResponse {
  return {
    id: "chatcmpl-tools",
    object: "chat.completion",
    created: 1,
    model: "glm-5",
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: toolNames.map((toolName, index) => ({
            id: `call-${index + 1}`,
            type: "function",
            function: { name: toolName, arguments: JSON.stringify({ probe: index + 1 }) },
          })),
        },
      },
    ],
  } as ChatCompletionResponse;
}

function finalResponse(): ChatCompletionResponse {
  return {
    id: "chatcmpl-final",
    object: "chat.completion",
    created: 2,
    model: "glm-5",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "All evidence gathered." } }],
  } as ChatCompletionResponse;
}

function turnInput(sessionSuffix: string): ChatTurnAgentRunnerInput {
  return {
    sessionId: `sess-parallel-${sessionSuffix}`,
    turnId: `turn-parallel-${sessionSuffix}`,
    userMessageId: `msg-parallel-${sessionSuffix}`,
    content: "gather the three pieces of evidence",
    mode: "chat",
    providerId: "glm",
    model: "glm-5",
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "minimal",
    speedMode: "standard",
    subagentPolicy: "off",
    normalizationProfile: "standard",
    toolAutonomy: "safe_auto",
    historyMessages: [{ role: "user", content: "gather the three pieces of evidence" }],
  } as ChatTurnAgentRunnerInput;
}

function buildHarness(input: {
  toolNames: readonly string[];
  delaysByProbeMs: Record<number, number>;
  parallelDisabled?: boolean;
  failingProbe?: number;
  accessRequiresApproval?: boolean;
}) {
  const timings: ToolTiming[] = [];
  const completionRequests: ChatCompletionRequest[] = [];
  let completionCount = 0;
  const createChatCompletion = vi.fn(async (request: ChatCompletionRequest) => {
    completionRequests.push(request);
    completionCount += 1;
    return completionCount === 1 ? toolCallsResponse(input.toolNames) : finalResponse();
  });
  const invokeTool = vi.fn(
    async (request: { toolName: string; args?: Record<string, unknown> }): Promise<ToolInvokeResult> => {
      const probe = Number(request.args?.probe ?? 0);
      const startedAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, input.delaysByProbeMs[probe] ?? 10));
      const finishedAt = Date.now();
      timings.push({ toolName: request.toolName, probe, startedAt, finishedAt });
      if (input.failingProbe === probe) {
        return { outcome: "failed", error: "synthetic tool failure" } as ToolInvokeResult;
      }
      return { outcome: "executed", result: { ok: true, probe } } as ToolInvokeResult;
    },
  );
  const storage = createMockStorage();
  const orchestrator = new ChatTurnAgentRunner({
    storage: storage as never,
    listToolCatalog: () => createToolCatalog(["memory.read", "shell.exec"]),
    createChatCompletion: createChatCompletion as never,
    invokeTool: invokeTool as never,
    // The batch preflight requires proof the whole batch is approval-free;
    // absent evaluator ⇒ serial, so every parallel test wires a clean one.
    evaluateToolAccess: () => ({
      allowed: true,
      requiresApproval: input.accessRequiresApproval === true,
      reasonCodes: [],
    }),
    parallelToolExecutionV1Disabled: () => input.parallelDisabled === true,
  } as never);
  return { orchestrator, timings, completionRequests, invokeTool, storage };
}

function toolMessagesOf(request: ChatCompletionRequest | undefined) {
  return (request?.messages ?? []).filter((message) => message.role === "tool") as Array<{
    tool_call_id: string;
    content: string;
  }>;
}

describe("ChatTurnAgentRunner parallel read-only tool batches", () => {
  it("overlaps an all-read-only batch instead of running it serially", async () => {
    const harness = buildHarness({
      toolNames: READ_ONLY_BATCH,
      delaysByProbeMs: { 1: 150, 2: 40, 3: 40 },
    });
    await harness.orchestrator.run(turnInput("overlap"));

    expect(harness.timings).toHaveLength(3);
    const maxStarted = Math.max(...harness.timings.map((timing) => timing.startedAt));
    const minFinished = Math.min(...harness.timings.map((timing) => timing.finishedAt));
    // Every call starts before the fastest one finishes ⇒ true overlap.
    expect(maxStarted).toBeLessThan(minFinished);
  });

  it("reuses a settled approved call before admitting a read-only parallel batch", async () => {
    const suffix = "approved-reuse";
    const input = turnInput(suffix);
    const harness = buildHarness({
      toolNames: ["memory.read", "memory.read"],
      delaysByProbeMs: { 1: 20, 2: 20 },
    });
    harness.storage.chatToolRuns.create({
      toolRunId: "tool-run-approved-memory-read",
      turnId: input.turnId,
      sessionId: input.sessionId,
      toolName: "memory.read",
      status: "executed",
      approvalId: "approval-memory-read",
      args: { probe: 1 },
      result: { ok: true, probe: 1, approved: true },
      startedAt: "2026-08-06T00:00:00.000Z",
      finishedAt: "2026-08-06T00:00:01.000Z",
    });

    await harness.orchestrator.run(input);

    expect(harness.invokeTool).toHaveBeenCalledTimes(1);
    expect(harness.invokeTool.mock.calls[0]?.[0].args).toEqual({ probe: 2 });
    expect(harness.storage.chatToolRuns.listByTurn(input.turnId)).toHaveLength(2);
    const continuationMessages = toolMessagesOf(harness.completionRequests[1]);
    expect(continuationMessages.slice(-2).map((message) => message.tool_call_id)).toEqual(["call-1", "call-2"]);
    expect(continuationMessages.find((message) => message.tool_call_id === "call-1")?.content).toContain(
      '"approved":true',
    );
  });

  it("appends tool results in emission order even when the first call finishes last", async () => {
    const harness = buildHarness({
      toolNames: READ_ONLY_BATCH,
      delaysByProbeMs: { 1: 150, 2: 20, 3: 20 },
    });
    await harness.orchestrator.run(turnInput("ordering"));

    expect(harness.timings).toHaveLength(3);
    const toolMessages = toolMessagesOf(harness.completionRequests[1]);
    expect(toolMessages.map((message) => message.tool_call_id)).toEqual(["call-1", "call-2", "call-3"]);
    expect(toolMessages.map((message) => message.content)).toEqual([
      JSON.stringify({ ok: true, probe: 1 }),
      JSON.stringify({ ok: true, probe: 2 }),
      JSON.stringify({ ok: true, probe: 3 }),
    ]);
  });

  it("keeps a batch containing a non-read-only tool strictly serial", async () => {
    const harness = buildHarness({
      toolNames: ["memory.read", "shell.exec"],
      delaysByProbeMs: { 1: 60, 2: 60 },
    });
    await harness.orchestrator.run(turnInput("mixed"));

    expect(harness.timings).toHaveLength(2);
    const [first, second] = harness.timings;
    expect(second!.startedAt).toBeGreaterThanOrEqual(first!.finishedAt);
  });

  it("keeps the batch serial when access evaluation says approval could be required", async () => {
    const harness = buildHarness({
      toolNames: READ_ONLY_BATCH,
      delaysByProbeMs: { 1: 60, 2: 60, 3: 60 },
      accessRequiresApproval: true,
    });
    await harness.orchestrator.run(turnInput("approval-preflight"));

    expect(harness.timings.length).toBeGreaterThanOrEqual(1);
    const ordered = [...harness.timings].sort((left, right) => left.startedAt - right.startedAt);
    for (let index = 1; index < ordered.length; index += 1) {
      expect(ordered[index]!.startedAt).toBeGreaterThanOrEqual(ordered[index - 1]!.finishedAt);
    }
  });

  it("keeps the batch serial when the kill switch is on", async () => {
    const harness = buildHarness({
      toolNames: READ_ONLY_BATCH,
      delaysByProbeMs: { 1: 60, 2: 60, 3: 60 },
      parallelDisabled: true,
    });
    await harness.orchestrator.run(turnInput("killswitch"));

    expect(harness.timings).toHaveLength(3);
    const ordered = [...harness.timings].sort((left, right) => left.startedAt - right.startedAt);
    expect(ordered[1]!.startedAt).toBeGreaterThanOrEqual(ordered[0]!.finishedAt);
    expect(ordered[2]!.startedAt).toBeGreaterThanOrEqual(ordered[1]!.finishedAt);
  });

  it("produces the same tool-result payloads and stored records as the serial path when one call fails", async () => {
    const runScenario = async (parallelDisabled: boolean, suffix: string) => {
      const harness = buildHarness({
        toolNames: READ_ONLY_BATCH,
        delaysByProbeMs: { 1: 30, 2: 30, 3: 30 },
        failingProbe: 2,
        parallelDisabled,
      });
      await harness.orchestrator.run(turnInput(suffix));
      const toolMessages = toolMessagesOf(harness.completionRequests[1]);
      const records = (
        harness.storage as {
          chatToolRuns: { listByTurn(turnId: string): Array<{ toolName: string; status: string; error?: string }> };
        }
      ).chatToolRuns
        .listByTurn(`turn-parallel-${suffix}`)
        .map((record) => ({ toolName: record.toolName, status: record.status, error: record.error }));
      return { toolMessages, records };
    };

    const parallel = await runScenario(false, "failure-parallel");
    const serial = await runScenario(true, "failure-serial");

    expect(parallel.toolMessages.map((message) => message.tool_call_id)).toEqual(
      serial.toolMessages.map((message) => message.tool_call_id),
    );
    expect(parallel.toolMessages.map((message) => message.content)).toEqual(
      serial.toolMessages.map((message) => message.content),
    );
    expect(parallel.records).toEqual(serial.records);
    expect(parallel.records).toHaveLength(3);
  });
});

describe("ChatTurnAgentRunner parallel batch approval pause", () => {
  it("surfaces already-executed sibling results instead of skip markers when one call needs approval", async () => {
    const timings: ToolTiming[] = [];
    const completionRequests: ChatCompletionRequest[] = [];
    const createChatCompletion = vi.fn(async (request: ChatCompletionRequest) => {
      completionRequests.push(request);
      return toolCallsResponse(READ_ONLY_BATCH);
    });
    const invokeTool = vi.fn(
      async (request: { toolName: string; args?: Record<string, unknown> }): Promise<ToolInvokeResult> => {
        const probe = Number(request.args?.probe ?? 0);
        const startedAt = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 20));
        timings.push({ toolName: request.toolName, probe, startedAt, finishedAt: Date.now() });
        if (probe === 2) {
          return {
            outcome: "approval_required",
            policyReason: "grant requires approval",
            auditEventId: "audit-parallel-approval",
            approvalId: "approval-parallel-2",
            expiresAt: "2026-12-31T00:00:00.000Z",
          } as ToolInvokeResult;
        }
        return { outcome: "executed", result: { ok: true, probe } } as ToolInvokeResult;
      },
    );
    const storage = createMockStorage();
    const orchestrator = new ChatTurnAgentRunner({
      storage: storage as never,
      listToolCatalog: () => createToolCatalog(["memory.read"]),
      createChatCompletion: createChatCompletion as never,
      invokeTool: invokeTool as never,
      // Access preflight says clean, but invoke-time policy still parks call 2
      // — the evaluate/invoke disagreement this test pins (residual I3 net).
      evaluateToolAccess: () => ({ allowed: true, requiresApproval: false, reasonCodes: [] }),
      parallelToolExecutionV1Disabled: () => false,
    } as never);

    const result = await orchestrator.run(turnInput("approval-pause"));

    // All three ran (parallel batch), the second parked the turn on approval,
    // and every call's REAL record is persisted — a resumed turn rebuilds from
    // these records instead of redoing the read-only work.
    expect(timings).toHaveLength(3);
    expect(result.turnTrace.status).toBe("waiting_for_approval");
    const runs = (
      storage as unknown as {
        chatToolRuns: { listByTurn(turnId: string): Array<{ status: string }> };
      }
    ).chatToolRuns.listByTurn("turn-parallel-approval-pause");
    expect(runs).toHaveLength(3);
    expect(runs.filter((run) => run.status === "approval_required")).toHaveLength(1);
    expect(runs.filter((run) => run.status === "executed")).toHaveLength(2);
  });
});

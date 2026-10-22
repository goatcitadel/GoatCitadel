import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalJsonString, type ChatCompletionResponse, type DurableCheckpointRecord } from "@goatcitadel/contracts";
import {
  claimDelegatedResultCorrection,
  resolveAdmittedDelegatedResultContract,
} from "./chat-delegated-result-contract.js";
import { ChatTurnAgentRunner, type ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";
import { createMockStorage, createToolCatalog, toolCallCompletion } from "./chat-turn-agent-runner-test-fixtures.js";

const schema = {
  type: "object",
  properties: { answer: { type: "string", maxLength: 100 } },
  required: ["answer"],
  additionalProperties: false,
};
const hash = (value: unknown) => createHash("sha256").update(canonicalJsonString(value)).digest("hex");
function fixture() {
  const request = { content: "Answer directly.", parentDelegationStepId: "step", policyRunId: "delegation" };
  const material = hash({ version: 2, request });
  const payload = {
    version: "chat.turn.execute.v2",
    admissionId: "admission",
    sessionIncarnationId: "incarnation",
    workspaceId: "workspace",
    sessionId: "session",
    turnId: "turn",
    admissionAggregateRevision: 1,
    admissionControllerGeneration: 1,
    admissionMaterialSha256: material,
    effectiveRequestMaterialSha256: hash({ version: 1, admissionMaterialSha256: material, request }),
    requestActor: { actorKind: "operator", actorId: "operator", operatorId: "operator" },
    userMessageId: "user",
    assistantMessageId: "assistant",
    branchKind: "append",
    threadEventType: "chat_thread_turn_appended",
    request,
  };
  const run = { runId: "run", workflowKey: "chat.turn.execute", status: "running", payload };
  const step = {
    stepId: "step",
    runId: "delegation",
    role: "worker",
    status: "running",
    childSessionId: "session",
    childTurnId: "turn",
    durableRunId: "run",
    instructionSnapshot: { resultSchema: schema },
  };
  let checkpoint: DurableCheckpointRecord | undefined;
  const storage = {
    ...(createMockStorage() as Record<string, unknown>),
    chatDelegationSteps: { get: vi.fn(async () => step) },
    durableRuns: {
      getRun: vi.fn(async () => run),
      getLatestCheckpointByKind: vi.fn(async () => checkpoint),
      createCheckpoint: vi.fn(async (value) => {
        checkpoint = { ...value, createdAt: new Date().toISOString() };
        return checkpoint;
      }),
    },
  };
  const input: ChatTurnAgentRunnerInput = {
    sessionId: "session",
    turnId: "turn",
    workspaceId: "workspace",
    userMessageId: "user",
    content: request.content,
    mode: "chat",
    providerId: "primary",
    model: "model",
    webMode: "off",
    memoryMode: "off",
    retrievalMode: "standard",
    thinkingLevel: "standard",
    toolAutonomy: "safe_auto",
    policyRunId: "delegation",
    canonicalDurableRunId: "run",
    parentDelegationStepId: "step",
    canonicalWriteFence: async <T>(work: () => T | Promise<T>): Promise<Awaited<T>> => await work(),
    historyMessages: [{ role: "user", content: request.content }],
  };
  return { storage, input, step, run };
}
const response = (content: string): ChatCompletionResponse => ({
  model: "model",
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
});

describe("admitted delegated result correction", () => {
  it("claims once before model execution and refuses replay after a crash", async () => {
    const f = fixture();
    const contract = await resolveAdmittedDelegatedResultContract(f.storage as never, f.input);
    expect(contract?.schema).toEqual(schema);
    expect(contract?.runId).toBe("run");
    expect(f.storage.durableRuns.getRun).toHaveBeenCalledWith("run");
    expect(f.storage.durableRuns.getRun).not.toHaveBeenCalledWith("delegation");
    await claimDelegatedResultCorrection(f.storage as never, f.input, contract!);
    expect(f.storage.durableRuns.createCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpointId: "delegated-result-correction:run",
        state: expect.objectContaining({ consumed: true, schemaSha256: hash(schema) }),
      }),
    );
    await expect(claimDelegatedResultCorrection(f.storage as never, f.input, contract!)).rejects.toThrow(
      /already consumed/,
    );
    await expect(resolveAdmittedDelegatedResultContract(f.storage as never, f.input)).rejects.toThrow(
      /already consumed/,
    );
    expect(f.storage.durableRuns.createCheckpoint).toHaveBeenCalledOnce();
  });
  it.each(["turn", "run", "schema", "delegation", "durable-run"])(
    "rejects current %s binding drift before consuming a correction",
    async (drift) => {
      const f = fixture();
      const contract = await resolveAdmittedDelegatedResultContract(f.storage as never, f.input);
      if (drift === "turn") f.step.childTurnId = "other";
      if (drift === "run") f.run.status = "cancelled";
      if (drift === "schema") f.step.instructionSnapshot = { resultSchema: { ...schema, required: [] } };
      if (drift === "delegation") f.step.runId = "other-delegation";
      if (drift === "durable-run") f.input.canonicalDurableRunId = "other-run";
      await expect(claimDelegatedResultCorrection(f.storage as never, f.input, contract!)).rejects.toThrow(
        /canonical child binding/,
      );
      expect(f.storage.durableRuns.createCheckpoint).not.toHaveBeenCalled();
    },
  );
  it("corrects an invalid final handoff once inside the original turn with tools disabled", async () => {
    const f = fixture();
    const createChatCompletion = vi.fn(async (request) => {
      expect(request.memory.runId).toBe("run");
      if (createChatCompletion.mock.calls.length === 1) return response("A direct answer.");
      expect(f.storage.durableRuns.createCheckpoint).toHaveBeenCalledOnce();
      expect(request.tools).toBeUndefined();
      expect(request.memory.runId).toBe("run");
      expect(request.timeoutMs).toBeGreaterThan(0);
      return response('{"answer":"A direct answer."}');
    });
    const runner = new ChatTurnAgentRunner({
      storage: f.storage as never,
      listToolCatalog: () => [],
      invokeTool: vi.fn(),
      createChatCompletion,
    });
    const result = await runner.run(f.input);
    expect(result.turnTrace.status).toBe("completed");
    expect(result.assistantContent).toBe('{"answer":"A direct answer."}');
    expect(createChatCompletion).toHaveBeenCalledTimes(2);
  });
  it("keeps the Deep evidence note out of a structured child result", async () => {
    const f = fixture();
    const createChatCompletion = vi.fn(async () =>
      createChatCompletion.mock.calls.length === 1
        ? toolCallCompletion("debezium logical replication")
        : response('{"answer":"Use logical replication."}'),
    );
    const invokeTool = vi.fn(async (_request: { toolName: string }) => ({
      outcome: "executed",
      policyReason: "allowed",
      result: { results: [] },
    }));
    const runner = new ChatTurnAgentRunner({
      storage: f.storage as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      invokeTool: invokeTool as never,
      createChatCompletion,
    });
    const result = await runner.run({ ...f.input, webMode: "deep" });
    expect(invokeTool.mock.calls.some(([request]) => request.toolName === "browser.search")).toBe(true);
    expect(JSON.parse(result.assistantContent)).toEqual({ answer: "Use logical replication." });
    expect(f.storage.durableRuns.createCheckpoint).not.toHaveBeenCalled();
  });
  it("does not retry a second invalid correction and never labels it completed", async () => {
    const f = fixture();
    const createChatCompletion = vi.fn(async () => response("Still not JSON."));
    const runner = new ChatTurnAgentRunner({
      storage: f.storage as never,
      listToolCatalog: () => [],
      invokeTool: vi.fn(),
      createChatCompletion,
    });
    const result = await runner.run(f.input);
    expect(result.turnTrace.status).toBe("failed");
    expect(result.turnTrace.failure?.message).toMatch(/single correction attempt/);
    expect(createChatCompletion).toHaveBeenCalledTimes(2);
    await expect(runner.run(f.input)).rejects.toThrow(/already consumed/);
    expect(createChatCompletion).toHaveBeenCalledTimes(2);
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  SCHEDULED_TURN_PERMISSION_PROFILE_ID,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ToolInvokeResult,
} from "@goatcitadel/contracts";
import type { ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";
import { ChatTurnAgentRunner } from "./chat-turn-agent-runner.js";
import {
  createMockStorage,
  createToolCatalog,
  namedToolCallCompletion,
} from "./chat-turn-agent-runner-test-fixtures.js";

const FANOUT_MODEL_TOOL_NAME = "agent_fanout";

function finalResponse(): ChatCompletionResponse {
  return {
    id: "chatcmpl-final",
    object: "chat.completion",
    created: 2,
    model: "glm-5",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Done." } }],
  } as ChatCompletionResponse;
}

function multiFanoutToolCallCompletion(calls: Array<{ id: string; subtasks: Array<{ objective: string }> }>) {
  return {
    id: "chatcmpl-fanout-multi",
    object: "chat.completion",
    created: 1,
    model: "glm-5",
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: "",
          tool_calls: calls.map((call) => ({
            id: call.id,
            type: "function",
            function: {
              name: FANOUT_MODEL_TOOL_NAME,
              arguments: JSON.stringify({ subtasks: call.subtasks }),
            },
          })),
        },
      },
    ],
  } as ChatCompletionResponse;
}

function turnInput(overrides: Partial<ChatTurnAgentRunnerInput> & { sessionSuffix: string }): ChatTurnAgentRunnerInput {
  const { sessionSuffix, ...rest } = overrides;
  return {
    sessionId: `sess-fanout-${sessionSuffix}`,
    turnId: `turn-fanout-${sessionSuffix}`,
    userMessageId: `msg-fanout-${sessionSuffix}`,
    content: "Compare vendor A, vendor B, and vendor C on pricing and support.",
    mode: "chat",
    providerId: "glm",
    model: "glm-5",
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "minimal",
    speedMode: "standard",
    subagentPolicy: "auto_when_useful",
    normalizationProfile: "live",
    toolAutonomy: "safe_auto",
    historyMessages: [{ role: "user", content: "Compare vendor A, vendor B, and vendor C." }],
    ...rest,
  } as ChatTurnAgentRunnerInput;
}

function buildHarness(input: {
  responses?: ChatCompletionResponse[];
  fanoutDisabled?: boolean;
  durableFanoutEnabled?: boolean;
  fanoutAvailable?: boolean;
  invokeResult?: ToolInvokeResult;
}) {
  const completionRequests: ChatCompletionRequest[] = [];
  let completionCount = 0;
  const responses = input.responses ?? [finalResponse()];
  const createChatCompletion = vi.fn(async (request: ChatCompletionRequest) => {
    completionRequests.push(request);
    const response = responses[Math.min(completionCount, responses.length - 1)]!;
    completionCount += 1;
    return response;
  });
  const invokeTool = vi.fn(
    async (): Promise<ToolInvokeResult> =>
      input.invokeResult ?? ({ outcome: "executed", result: { status: "completed", results: [] } } as ToolInvokeResult),
  );
  const orchestrator = new ChatTurnAgentRunner({
    storage: createMockStorage() as never,
    listToolCatalog: () => createToolCatalog(["agent.fanout", "memory.read"]),
    createChatCompletion: createChatCompletion as never,
    invokeTool: invokeTool as never,
    evaluateToolAccess: () => ({ allowed: true, requiresApproval: false, reasonCodes: [] }),
    subagentFanoutV1Disabled: () => input.fanoutDisabled === true,
    durableChatFanoutV1Enabled: async () => input.durableFanoutEnabled ?? true,
    isDurableFanoutAvailable: async () => input.fanoutAvailable ?? true,
  } as never);
  return { orchestrator, completionRequests, invokeTool };
}

function exposedToolNames(request: ChatCompletionRequest | undefined): string[] {
  return (request?.tools ?? [])
    .map((tool) => (tool as { function?: { name?: string } }).function?.name)
    .filter((name): name is string => typeof name === "string");
}

describe("ChatTurnAgentRunner agent.fanout exposure (R3-8)", () => {
  it("exposes agent.fanout in Chat when subagentPolicy auto-delegates subagents", async () => {
    const harness = buildHarness({});
    await harness.orchestrator.run(turnInput({ sessionSuffix: "chat-on", subagentPolicy: "auto_when_useful" }));
    expect(exposedToolNames(harness.completionRequests[0])).toContain(FANOUT_MODEL_TOOL_NAME);
  });

  it("hides agent.fanout when subagentPolicy asks before delegating", async () => {
    const harness = buildHarness({});
    await harness.orchestrator.run(turnInput({ sessionSuffix: "chat-ask", subagentPolicy: "ask_when_useful" }));
    expect(exposedToolNames(harness.completionRequests[0])).not.toContain(FANOUT_MODEL_TOOL_NAME);
  });

  it("hides agent.fanout from legacy unnormalized Cowork or Code modes", async () => {
    const harness = buildHarness({});
    await harness.orchestrator.run(
      turnInput({ sessionSuffix: "code-legacy", mode: "code", subagentPolicy: "auto_when_useful" }),
    );
    expect(exposedToolNames(harness.completionRequests[0])).not.toContain(FANOUT_MODEL_TOOL_NAME);
    await harness.orchestrator.run(
      turnInput({ sessionSuffix: "cowork-legacy", mode: "cowork", subagentPolicy: "auto_when_useful" }),
    );
    expect(exposedToolNames(harness.completionRequests[1])).not.toContain(FANOUT_MODEL_TOOL_NAME);
  });

  it("hides agent.fanout when subagentPolicy is off", async () => {
    const harness = buildHarness({});
    await harness.orchestrator.run(turnInput({ sessionSuffix: "policy-off", subagentPolicy: "off" }));
    expect(exposedToolNames(harness.completionRequests[0])).not.toContain(FANOUT_MODEL_TOOL_NAME);
  });

  it("hides agent.fanout when the subagentFanoutV1Disabled kill switch is on", async () => {
    const harness = buildHarness({ fanoutDisabled: true });
    await harness.orchestrator.run(turnInput({ sessionSuffix: "kill-switch" }));
    expect(exposedToolNames(harness.completionRequests[0])).not.toContain(FANOUT_MODEL_TOOL_NAME);
  });

  it("fails closed when the durable rollout or exact active-project grant is unavailable", async () => {
    const rolloutOff = buildHarness({ durableFanoutEnabled: false });
    await rolloutOff.orchestrator.run(turnInput({ sessionSuffix: "rollout-off" }));
    expect(exposedToolNames(rolloutOff.completionRequests[0])).not.toContain(FANOUT_MODEL_TOOL_NAME);

    const noProjectGrant = buildHarness({ fanoutAvailable: false });
    await noProjectGrant.orchestrator.run(turnInput({ sessionSuffix: "no-project-grant" }));
    expect(exposedToolNames(noProjectGrant.completionRequests[0])).not.toContain(FANOUT_MODEL_TOOL_NAME);
  });

  it("hides agent.fanout from restricted autonomous (scheduled) turns", async () => {
    const harness = buildHarness({});
    await harness.orchestrator.run(
      turnInput({ sessionSuffix: "scheduled", permissionProfileId: SCHEDULED_TURN_PERMISSION_PROFILE_ID }),
    );
    expect(exposedToolNames(harness.completionRequests[0])).not.toContain(FANOUT_MODEL_TOOL_NAME);
  });
});

describe("ChatTurnAgentRunner agent.fanout invocation (R3-8)", () => {
  it("routes a model agent.fanout call through the normal invokeTool policy path", async () => {
    const subtasks = [{ objective: "Research vendor A" }, { objective: "Research vendor B" }];
    const harness = buildHarness({
      responses: [namedToolCallCompletion("agent.fanout", { subtasks }), finalResponse()],
      invokeResult: {
        outcome: "executed",
        result: {
          status: "completed",
          subtaskCount: 2,
          completedCount: 2,
          failedCount: 0,
          results: [
            { index: 0, objective: "Research vendor A", status: "completed", output: "A findings" },
            { index: 1, objective: "Research vendor B", status: "completed", output: "B findings" },
          ],
        },
      } as ToolInvokeResult,
    });

    await harness.orchestrator.run(turnInput({ sessionSuffix: "invoke", subagentPolicy: "auto_when_useful" }));

    expect(harness.invokeTool).toHaveBeenCalledTimes(1);
    const request = harness.invokeTool.mock.calls[0]![0] as { toolName: string; args: Record<string, unknown> };
    expect(request.toolName).toBe("agent.fanout");
    expect(request.args).toMatchObject({ subtasks });
    // The aggregated child results come back to the model as a buffered tool message.
    const followUp = harness.completionRequests[1];
    const toolMessages = (followUp?.messages ?? []).filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(String((toolMessages[0] as { content?: unknown }).content)).toContain("A findings");
  });

  it("parks a durable fan-out parent without speculative synthesis while children are waiting", async () => {
    const harness = buildHarness({
      responses: [
        namedToolCallCompletion("agent.fanout", { subtasks: [{ objective: "Research vendor A" }] }),
        finalResponse(),
      ],
      invokeResult: {
        outcome: "executed",
        result: {
          status: "waiting",
          fanoutInvocationId: "fanout-invocation-1",
          subtaskCount: 1,
          results: [{ index: 0, objective: "Research vendor A", status: "running" }],
        },
      } as ToolInvokeResult,
    });

    const result = await harness.orchestrator.run(
      turnInput({ sessionSuffix: "durable-wait", subagentPolicy: "auto_when_useful" }),
    );

    expect(harness.invokeTool).toHaveBeenCalledTimes(1);
    expect(harness.completionRequests).toHaveLength(1);
    expect(result.assistantContent).toBe("");
    expect(result.turnTrace.status).toBe("waiting_for_tool");
    expect(result.turnTrace.completion).toMatchObject({ status: "backgrounded" });
  });

  it("charges parent tool-run budget by fan-out subtask count", async () => {
    const harness = buildHarness({
      responses: [
        multiFanoutToolCallCompletion([
          {
            id: "fanout-three",
            subtasks: [{ objective: "Research A" }, { objective: "Research B" }, { objective: "Research C" }],
          },
          {
            id: "fanout-two",
            subtasks: [{ objective: "Research D" }, { objective: "Research E" }],
          },
        ]),
        finalResponse(),
      ],
      invokeResult: {
        outcome: "executed",
        result: {
          status: "completed",
          subtaskCount: 3,
          completedCount: 3,
          failedCount: 0,
          results: [],
        },
      } as ToolInvokeResult,
    });

    await harness.orchestrator.run(turnInput({ sessionSuffix: "budget-weighted", subagentPolicy: "auto_when_useful" }));

    expect(harness.invokeTool).toHaveBeenCalledTimes(1);
    expect((harness.invokeTool.mock.calls[0]![0] as { args: Record<string, unknown> }).args).toMatchObject({
      subtasks: [{ objective: "Research A" }, { objective: "Research B" }, { objective: "Research C" }],
    });
  });
});

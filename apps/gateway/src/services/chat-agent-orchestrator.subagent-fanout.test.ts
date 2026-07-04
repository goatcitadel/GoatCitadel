import { describe, expect, it, vi } from "vitest";
import {
  SCHEDULED_TURN_PERMISSION_PROFILE_ID,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ToolInvokeResult,
} from "@goatcitadel/contracts";
import type { ChatAgentTurnInput } from "./chat-agent-orchestrator.js";
import { ChatAgentOrchestrator } from "./chat-agent-orchestrator.js";
import {
  createMockStorage,
  createToolCatalog,
  namedToolCallCompletion,
} from "./chat-agent-orchestrator-test-fixtures.js";

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

function turnInput(overrides: Partial<ChatAgentTurnInput> & { sessionSuffix: string }): ChatAgentTurnInput {
  const { sessionSuffix, ...rest } = overrides;
  return {
    sessionId: `sess-fanout-${sessionSuffix}`,
    turnId: `turn-fanout-${sessionSuffix}`,
    userMessageId: `msg-fanout-${sessionSuffix}`,
    content: "Compare vendor A, vendor B, and vendor C on pricing and support.",
    mode: "cowork",
    providerId: "glm",
    model: "glm-5",
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "minimal",
    speedMode: "standard",
    subagentPolicy: "ask_when_useful",
    normalizationProfile: "live",
    toolAutonomy: "safe_auto",
    historyMessages: [{ role: "user", content: "Compare vendor A, vendor B, and vendor C." }],
    ...rest,
  } as ChatAgentTurnInput;
}

function buildHarness(input: {
  responses?: ChatCompletionResponse[];
  fanoutDisabled?: boolean;
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
  const orchestrator = new ChatAgentOrchestrator({
    storage: createMockStorage() as never,
    listToolCatalog: () => createToolCatalog(["agent.fanout", "memory.read"]),
    createChatCompletion: createChatCompletion as never,
    invokeTool: invokeTool as never,
    evaluateToolAccess: () => ({ allowed: true, requiresApproval: false, reasonCodes: [] }),
    subagentFanoutV1Disabled: () => input.fanoutDisabled === true,
  } as never);
  return { orchestrator, completionRequests, invokeTool };
}

function exposedToolNames(request: ChatCompletionRequest | undefined): string[] {
  return (request?.tools ?? [])
    .map((tool) => (tool as { function?: { name?: string } }).function?.name)
    .filter((name): name is string => typeof name === "string");
}

describe("ChatAgentOrchestrator agent.fanout exposure (R3-8)", () => {
  it("exposes agent.fanout in cowork when subagentPolicy allows subagents", async () => {
    const harness = buildHarness({});
    await harness.orchestrator.run(turnInput({ sessionSuffix: "cowork-on", subagentPolicy: "ask_when_useful" }));
    expect(exposedToolNames(harness.completionRequests[0])).toContain(FANOUT_MODEL_TOOL_NAME);
  });

  it("exposes agent.fanout in code mode under auto_when_useful", async () => {
    const harness = buildHarness({});
    await harness.orchestrator.run(
      turnInput({ sessionSuffix: "code-on", mode: "code", subagentPolicy: "auto_when_useful" }),
    );
    expect(exposedToolNames(harness.completionRequests[0])).toContain(FANOUT_MODEL_TOOL_NAME);
  });

  it("hides agent.fanout when subagentPolicy is off", async () => {
    const harness = buildHarness({});
    await harness.orchestrator.run(turnInput({ sessionSuffix: "policy-off", subagentPolicy: "off" }));
    expect(exposedToolNames(harness.completionRequests[0])).not.toContain(FANOUT_MODEL_TOOL_NAME);
  });

  it("hides agent.fanout in plain chat mode", async () => {
    const harness = buildHarness({});
    await harness.orchestrator.run(turnInput({ sessionSuffix: "chat-mode", mode: "chat" }));
    expect(exposedToolNames(harness.completionRequests[0])).not.toContain(FANOUT_MODEL_TOOL_NAME);
  });

  it("hides agent.fanout when the subagentFanoutV1Disabled kill switch is on", async () => {
    const harness = buildHarness({ fanoutDisabled: true });
    await harness.orchestrator.run(turnInput({ sessionSuffix: "kill-switch" }));
    expect(exposedToolNames(harness.completionRequests[0])).not.toContain(FANOUT_MODEL_TOOL_NAME);
  });

  it("hides agent.fanout from restricted autonomous (scheduled) turns", async () => {
    const harness = buildHarness({});
    await harness.orchestrator.run(
      turnInput({ sessionSuffix: "scheduled", permissionProfileId: SCHEDULED_TURN_PERMISSION_PROFILE_ID }),
    );
    expect(exposedToolNames(harness.completionRequests[0])).not.toContain(FANOUT_MODEL_TOOL_NAME);
  });
});

describe("ChatAgentOrchestrator agent.fanout invocation (R3-8)", () => {
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

    await harness.orchestrator.run(turnInput({ sessionSuffix: "invoke" }));

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
});

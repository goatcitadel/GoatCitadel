import { describe, it, expect, vi } from "vitest";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatOptionalUserInputReplyRecord,
  ChatUserInputPromptRecord,
} from "@goatcitadel/contracts";
import type { ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";
import {
  EffectAwareChatTurnAgentRunner,
  createMockStorage,
  createToolCatalog,
  namedToolCallCompletion,
} from "./chat-turn-agent-runner-test-fixtures.js";

const input: ChatTurnAgentRunnerInput = {
  sessionId: "sess-1",
  turnId: "turn-1",
  userMessageId: "msg-1",
  content: "Ask an optional style question with user_input.request and continue independent work.",
  mode: "chat",
  providerId: "fixture",
  model: "fixture",
  webMode: "off",
  memoryMode: "off",
  retrievalMode: "standard",
  thinkingLevel: "standard",
  speedMode: "standard",
  subagentPolicy: "off",
  toolAutonomy: "safe_auto",
  policyRunId: "run-1",
  canonicalWriteFence: async (work) => await work(),
  historyMessages: [{ role: "user", content: "Plan the work." }],
};
const done = (): ChatCompletionResponse => ({
  model: "fixture",
  choices: [{ index: 0, message: { role: "assistant", content: "Independent work is complete." } }],
});
function catalog(names: string[]) {
  return names.map((name) =>
    name === "user_input.request"
      ? {
          ...createToolCatalog(["session.status"])[0]!,
          toolName: name,
          argSchema: {
            type: "object",
            properties: { title: { type: "string" }, question: { type: "string" } },
            required: ["title", "question"],
          },
        }
      : createToolCatalog([name])[0]!,
  );
}
function reply(prompt: ChatUserInputPromptRecord): ChatOptionalUserInputReplyRecord {
  return {
    prompt,
    response: { kind: "text", text: "Prefer a concise style." },
    answeredAt: new Date().toISOString(),
    responder: { actorId: "operator", authActorSource: "token" },
    materialSha256: "a".repeat(64),
  };
}

describe("default-off async clarification in the existing runner", () => {
  it.each([undefined, false])("hides the tool when disabled (%s)", async (enabled) => {
    const requests: ChatCompletionRequest[] = [];
    const registerOptionalUserInput = vi.fn();
    const runner = new EffectAwareChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => catalog(["user_input.request"]),
      createChatCompletion: async (request) => {
        requests.push(request);
        return done();
      },
      invokeTool: vi.fn(),
      registerOptionalUserInput,
      ...(enabled === undefined ? {} : { chatAsyncClarificationV1Enabled: () => enabled }),
    });
    await runner.run(input);
    expect(JSON.stringify(requests[0]?.tools ?? [])).not.toContain("user_input_request");
    expect(registerOptionalUserInput).not.toHaveBeenCalled();
  });

  it("continues independent tools, then consumes a canonical answer once at the next model boundary", async () => {
    const requests: ChatCompletionRequest[] = [];
    const prompts: ChatUserInputPromptRecord[] = [];
    const replies: ChatOptionalUserInputReplyRecord[] = [];
    const registerOptionalUserInput = vi.fn(async (_input, prompt) => {
      prompts.push(prompt);
      return prompt;
    });
    const runner = new EffectAwareChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => catalog(["user_input.request", "session.status"]),
      chatAsyncClarificationV1Enabled: () => true,
      registerOptionalUserInput,
      readOptionalUserInput: async () => ({ prompts, replies }),
      createChatCompletion: async (request) => {
        requests.push({ ...request, messages: [...request.messages] });
        return requests.length === 1
          ? namedToolCallCompletion("user_input.request", { title: "Style", question: "Which style?" })
          : requests.length === 2
            ? namedToolCallCompletion("session.status", {})
            : done();
      },
      invokeTool: async (request) => {
        if (request.toolName === "session.status") replies.push(reply(prompts[0]!));
        return {
          outcome: "executed",
          auditEventId: "fixture-audit",
          result:
            request.toolName === "user_input.request"
              ? { status: "optional_input_requested", title: "Style", question: "Which style?" }
              : { ok: true },
        };
      },
    });
    const result = await runner.run(input);
    expect(result.turnTrace.status).toBe("completed");
    expect(result.turnTrace.pendingUserInput).toBeFalsy();
    expect(registerOptionalUserInput).toHaveBeenCalledTimes(1);
    expect(result.turnTrace.toolRuns.map((run) => run.toolName)).toEqual(["user_input.request", "session.status"]);
    expect(JSON.stringify(requests[1]?.messages)).not.toContain("Prefer a concise style.");
    expect(replies).toHaveLength(1);
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("Prefer a concise style.");
    expect(
      requests.at(-1)?.messages.filter((message) => String(message.content).includes("Prefer a concise style.")),
    ).toHaveLength(1);
  });

  it("replays persisted answers before the first recovered provider request and incorporates replies received during final generation", async () => {
    const prompt: ChatUserInputPromptRecord = {
      promptId: "optional-recovered",
      turnId: "turn-1",
      kind: "text",
      title: "Style",
      question: "Which style?",
      required: false,
      delivery: "background",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    for (const recovered of [true, false]) {
      const requests: ChatCompletionRequest[] = [];
      const replies = recovered ? [reply(prompt)] : [];
      const runner = new EffectAwareChatTurnAgentRunner({
        storage: createMockStorage() as never,
        listToolCatalog: () => createToolCatalog([]),
        chatAsyncClarificationV1Enabled: () => true,
        readOptionalUserInput: async () => ({ prompts: [prompt], replies }),
        createChatCompletion: async (request) => {
          requests.push({ ...request, messages: [...request.messages] });
          if (!recovered && requests.length === 1) replies.push(reply(prompt));
          return done();
        },
        invokeTool: vi.fn(),
      });
      expect((await runner.run(input)).turnTrace.status).toBe("completed");
      expect(requests).toHaveLength(recovered ? 1 : 2);
      expect(
        requests.at(-1)?.messages.filter((message) => String(message.content).includes("Prefer a concise style.")),
      ).toHaveLength(1);
    }
  });

  it("preserves a policy block and never issues a question from a rejected tool call", async () => {
    const registerOptionalUserInput = vi.fn();
    let calls = 0;
    const runner = new EffectAwareChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => catalog(["user_input.request"]),
      chatAsyncClarificationV1Enabled: () => true,
      registerOptionalUserInput,
      readOptionalUserInput: async () => ({ prompts: [], replies: [] }),
      createChatCompletion: async () =>
        ++calls === 1
          ? namedToolCallCompletion("user_input.request", { title: "Style", question: "Which style?" })
          : done(),
      invokeTool: async () => ({ outcome: "blocked", auditEventId: "blocked", policyReason: "Denied by policy." }),
    });
    const result = await runner.run(input);
    expect(registerOptionalUserInput).not.toHaveBeenCalled();
    expect(result.turnTrace.toolRuns[0]?.status).toBe("blocked");
  });
});

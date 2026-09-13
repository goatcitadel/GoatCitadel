import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  WORKFLOW_SKILL_CAPTURE_MARKER,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
} from "@goatcitadel/contracts";
import { ChatTurnAgentRunner, type ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";
import { createMockStorage, createToolCatalog } from "./chat-turn-agent-runner-test-fixtures.js";
import { ChatDelegationService } from "./chat-delegation-service.js";

const markdown =
  "---\nname: checklist-review\ndescription: Review a supplied checklist.\n---\n# Checklist review\n## Instructions\nCheck the named responsibilities and report omissions.";

function input(): ChatTurnAgentRunnerInput {
  const content = [
    WORKFLOW_SKILL_CAPTURE_MARKER + JSON.stringify({ sourceTurnId: "source" }),
    "Draft a reusable SKILL.md from the completed workflow below. Return only Markdown.",
    "<workflow_evidence>",
    JSON.stringify({
      request:
        "Research the current top ten local businesses. Check the time, read /workspace/logs.txt, and create a report document.",
      result: "The report was created.",
    }),
    "</workflow_evidence>",
  ].join("\n\n");
  return {
    sessionId: "sess-skill-capture",
    turnId: randomUUID(),
    userMessageId: randomUUID(),
    content,
    mode: "chat",
    providerId: "openai",
    model: "gpt-5.4",
    webMode: "auto",
    memoryMode: "off",
    thinkingLevel: "standard",
    toolAutonomy: "safe_auto",
    normalizationProfile: "live",
    historyMessages: [{ role: "user", content }],
  };
}

function setup(response: ChatCompletionResponse) {
  const createChatCompletion = vi
    .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
    .mockResolvedValue(response);
  const invokeTool = vi.fn();
  const runner = new ChatTurnAgentRunner({
    storage: createMockStorage() as never,
    listToolCatalog: () =>
      createToolCatalog([
        "documents.create",
        "browser.search",
        "browser.navigate",
        "time.now",
        "fs.list",
        "file.read_range",
      ]),
    createChatCompletion,
    invokeTool,
  });
  return { runner, invokeTool, createChatCompletion };
}

describe("workflow skill capture execution boundary", () => {
  it("rejects delegation of quoted capture evidence before creating child work", async () => {
    const getSession = vi.fn(async () => ({ sessionId: "sess-skill-capture" }));
    const delegation = new ChatDelegationService({ getSession } as never);
    await expect(
      delegation.runChatDelegation("sess-skill-capture", { objective: input().content, roles: ["ops"] }),
    ).rejects.toThrow("delegation is unavailable");
    await expect(
      delegation.suggestChatDelegation("sess-skill-capture", { objective: input().content }),
    ).rejects.toThrow("delegation is unavailable");
  });

  it("drafts through live Chat without executing quoted evidence or synthesizing a document tool", async () => {
    const { runner, invokeTool, createChatCompletion } = setup({
      model: "gpt-5.4",
      choices: [{ index: 0, message: { role: "assistant", content: markdown } }],
    });
    const request = input();
    expect((await runner.resolveCapabilityToolSchema(request)).tools).toEqual([]);
    const result = await runner.run(request);
    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(createChatCompletion.mock.calls[0]?.[0].tools ?? []).toEqual([]);
    expect(result.assistantContent).toBe(markdown);
    expect(result.turnTrace.status).toBe("completed");
    expect(invokeTool).not.toHaveBeenCalled();
  });

  it("fails closed when a provider requests a tool despite the draft-only schema", async () => {
    const { runner, invokeTool } = setup({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "unexpected-doc",
                type: "function",
                function: {
                  name: "documents_create",
                  arguments: JSON.stringify({ title: "Captured skill", body: markdown }),
                },
              },
            ],
          },
        },
      ],
    });
    const result = await runner.run(input());
    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.turnTrace.status).not.toBe("waiting_for_approval");
    expect(result.assistantContent).toContain("unsupported");
  });
});

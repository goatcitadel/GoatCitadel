import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionRequest, ChatToolRunRecord } from "@goatcitadel/contracts";
import type { ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";
import {
  EffectAwareChatTurnAgentRunner,
  createMockStorage,
  createToolCatalog,
} from "./chat-turn-agent-runner-test-fixtures.js";

describe("Google Calendar approval continuation", () => {
  it.each([
    { status: "granted", expected: "GoatCitadel granted 24 hours of read-only access in this Chat." },
    { status: "failed", expected: "GoatCitadel could not create the 24-hour read-only grant." },
    { status: "once", expected: undefined },
    {
      status: "granted",
      expected: "GoatCitadel granted 24 hours of read-only access in this Chat.",
      receiptOnly: true,
    },
  ])(
    "reports the approved Calendar read when the grant is $status ($receiptOnly)",
    async ({ status, expected, receiptOnly }) => {
      const approvalId = "approval-calendar";
      const toolName = "calendar.list";
      const sessionId = "calendar-test-chat";
      const turnId = "calendar-test-turn";
      const content = receiptOnly
        ? "Check my calendar. Ask for approval first. After the decision, report only whether the read succeeded and what grant was created, if any."
        : "Check my calendar and list the events. Ask for my approval first.";
      const input: ChatTurnAgentRunnerInput = {
        sessionId,
        workspaceId: "default",
        turnId,
        userMessageId: "calendar-test-message",
        content,
        mode: "chat",
        model: "test-model",
        webMode: "off",
        memoryMode: "off",
        subagentPolicy: "off",
        historyMessages: [{ role: "user", content }],
      };
      const baseStorage = createMockStorage() as { chatToolRuns: { create(run: ChatToolRunRecord): void } };
      baseStorage.chatToolRuns.create({
        sessionId,
        turnId,
        toolRunId: "calendar-tool-run",
        approvalId,
        toolName,
        status: "executed",
        args: { calendarId: "primary" },
        result: { status: "sent", records: [] },
        startedAt: "2026-11-18T00:00:00.000Z",
        finishedAt: "2026-11-18T00:01:00.000Z",
      });
      const storage = {
        ...baseStorage,
        approvals: {
          get: vi.fn(async () => ({
            approvalId,
            kind: toolName,
            status: "approved",
            linkage: { workspaceId: "default", sessionId, turnId, toolName, actionType: "tool.invoke" },
          })),
        },
        approvalEvents: {
          listByApprovalId: vi.fn(() => [
            {
              eventType: "resolved",
              payload: {
                outcome: "approved",
                ...(status === "once"
                  ? {}
                  : {
                      chatReadAllowance: {
                        status,
                        duration: "24h",
                        ...(status === "granted" ? { expiresAt: "2026-11-19T00:00:00.000Z" } : {}),
                      },
                    }),
              },
            },
          ]),
        },
      };
      const createChatCompletion = vi.fn(async (request: ChatCompletionRequest) => {
        const knowsApproval = request.messages.some(
          (message) =>
            message.role === "system" && String(message.content).includes("read succeeded after your approval"),
        );
        return {
          id: "calendar-completion",
          object: "chat.completion",
          created: 1,
          model: "test-model",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: knowsApproval
                  ? "The read succeeded. No approval decision or new grant was confirmed.\n\nYour calendar is clear for that period."
                  : "I read your calendar without approval.",
              },
            },
          ],
        };
      });
      const invokeTool = vi.fn();
      const runner = new EffectAwareChatTurnAgentRunner({
        storage: storage as never,
        listToolCatalog: () => createToolCatalog([toolName]),
        createChatCompletion: createChatCompletion as never,
        invokeTool,
      } as never);

      const result = await runner.run(input);

      if (receiptOnly) {
        expect(createChatCompletion).not.toHaveBeenCalled();
        expect(result.assistantContent).toBe(
          "The Google Calendar read succeeded after your approval. GoatCitadel granted 24 hours of read-only access in this Chat.",
        );
      } else {
        expect(result.assistantContent).toContain("Your calendar is clear for that period.");
      }
      expect(result.assistantContent).toContain("The Google Calendar read succeeded after your approval.");
      expect(result.assistantContent).not.toContain("without approval");
      expect(result.assistantContent).not.toContain("No approval decision");
      if (expected) expect(result.assistantContent).toContain(expected);
      else expect(result.assistantContent).not.toContain("24-hour");
      expect(invokeTool).not.toHaveBeenCalled();
    },
  );
});

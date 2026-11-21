import { describe, expect, it, vi } from "vitest";
import { HEARTBEAT_PERMISSION_PROFILE_ID } from "@goatcitadel/contracts";
import { createDefaultToolRegistry } from "@goatcitadel/policy-engine";
import { ChatTurnAgentRunner, type ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";
import { createMockStorage } from "./chat-turn-agent-runner-test-fixtures.js";

describe("Chat reminder preview tool exposure", () => {
  it.each([
    { enabled: true, allowed: true, offered: true, turn: {} },
    { enabled: false, allowed: true, offered: false, turn: {} },
    { enabled: true, allowed: false, offered: false, turn: {} },
    { enabled: true, allowed: true, offered: false, turn: { permissionProfileId: HEARTBEAT_PERMISSION_PROFILE_ID } },
    { enabled: true, allowed: true, offered: false, turn: { parentDelegationStepId: "child" } },
  ])(
    "checks the feature, policy and active turn before advertising review (%j)",
    async ({ enabled, allowed, offered, turn }) => {
      const runner = new ChatTurnAgentRunner({
        storage: createMockStorage() as never,
        listToolCatalog: () =>
          createDefaultToolRegistry()
            .toCatalog()
            .filter((tool) => tool.toolName === "chat.reminder.preview"),
        evaluateToolAccess: () => ({ allowed, requiresApproval: false, reasonCodes: [] }),
        toolExposureFlagEnabled: async (flag: string) => flag === "chatTimersV1Enabled" && enabled,
        invokeTool: vi.fn(),
        createChatCompletion: vi.fn(),
      } as never);
      const schema = await runner.resolveCapabilityToolSchema({
        sessionId: "one",
        turnId: "turn",
        userMessageId: "user",
        workspaceId: "workspace",
        mode: "chat",
        providerId: "glm",
        model: "glm-5",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "minimal",
        speedMode: "standard",
        normalizationProfile: "live",
        toolAutonomy: "safe_auto",
        content: "Remind me next Monday at 9 to call Jamie.",
        historyMessages: [],
        ...turn,
      } as ChatTurnAgentRunnerInput);
      expect(schema.canonicalToModel.has("chat.reminder.preview")).toBe(offered);
    },
  );
});

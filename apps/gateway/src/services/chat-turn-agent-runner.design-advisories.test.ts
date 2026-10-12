import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ToolInvokeRequest, ToolInvokeResult } from "@goatcitadel/contracts";
import type { ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";
import { createExecuteToolCallForTest } from "./chat-turn-agent-runner-test-fixtures.js";

const GRADIENT_CSS = ".hero h1 { background-clip: text; -webkit-text-fill-color: transparent; }";

function turnInput(overrides: Partial<ChatTurnAgentRunnerInput> = {}): ChatTurnAgentRunnerInput {
  const content = overrides.content ?? "Polish the hero styles.";
  return {
    sessionId: "sess-design-advisories",
    turnId: randomUUID(),
    userMessageId: "msg-design-advisories",
    content,
    mode: "chat",
    providerId: "glm",
    model: "glm-5",
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "standard",
    toolAutonomy: "safe_auto",
    historyMessages: [{ role: "user", content }],
    ...overrides,
  };
}

function profileWith(skillIds: string[]): ChatTurnAgentRunnerInput["capabilityProfile"] {
  return {
    profileId: "profile-design-advisories",
    identity: { workspaceId: "workspace-design" },
    catalog: {
      snapshotId: "snapshot-design-advisories",
      inspectableHash: "1".repeat(64),
      callableHash: "2".repeat(64),
      inspectableCount: 1,
      callableCount: 1,
    },
    selection: {
      tools: [],
      activatedSkills: skillIds.map((skillId) => ({
        capabilityId: `skill:${skillId}`,
        skillId,
        confidence: 0.9,
        reasons: ["routing_keyword"],
        treeSha256: "tree",
        instructionSha256: "instruction",
        instructionBytes: 10,
        modules: [{ name: "main", relativePath: "SKILL.md", sha256: "abc", bytes: 10 }],
      })),
    },
    governance: {
      policyDecisions: [
        { toolName: "fs.write", allowed: true, requiresApproval: false, reasonCodes: ["frozen_allowed"] },
      ],
    },
  } as unknown as ChatTurnAgentRunnerInput["capabilityProfile"];
}

describe("design advisories on governed UI file writes", () => {
  async function writeHero(capabilityProfile: ChatTurnAgentRunnerInput["capabilityProfile"]) {
    const invokeTool = vi.fn(
      async (request: ToolInvokeRequest): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        result: { path: request.args.path, bytesWritten: GRADIENT_CSS.length },
      }),
    );
    const executeToolCall = createExecuteToolCallForTest({
      invokeTool,
      toolNames: ["fs.write"],
      evaluateToolAccess: vi.fn(async () => ({ allowed: true, requiresApproval: false, reasonCodes: ["allowed"] })),
    });
    return executeToolCall({
      input: turnInput({ capabilityProfile }),
      turnId: "turn-design-advisories",
      toolName: "fs.write",
      rawArgs: { path: "src/hero.css", content: GRADIENT_CSS },
      localFileIntent: true,
    });
  }

  it("attaches advisories to an executed write when the frozen profile carries an impeccable receipt", async () => {
    const result = await writeHero(profileWith(["bundled:impeccable"]));

    expect(result.record.status, JSON.stringify(result.record)).toBe("executed");
    expect(result.record.result?.designAdvisories).toEqual([
      expect.objectContaining({ ruleId: "gradient-text", line: 1, craftFloorRule: "skill-ban-gradient-text" }),
    ]);
    expect(JSON.stringify(result.record.result)).not.toContain("background-clip");
  });

  it("leaves the result untouched without a design receipt", async () => {
    const result = await writeHero(profileWith(["bundled:coding"]));

    expect(result.record.status).toBe("executed");
    expect(result.record.result).not.toHaveProperty("designAdvisories");
  });
});

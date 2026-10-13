import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ChatTurnFeatureReferences, ToolInvokeRequest, ToolInvokeResult } from "@goatcitadel/contracts";
import type { ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";
import { createExecuteToolCallForTest, createMockStorage } from "./chat-turn-agent-runner-test-fixtures.js";

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

function admissionWith(skillIds: string[]): NonNullable<ChatTurnAgentRunnerInput["featureAdmission"]> {
  const references: ChatTurnFeatureReferences = {
    version: "chat.turn.feature-references.v1",
    selectedSkills: {
      selectionMode: "ranked",
      instructionBudgetTokens: 2048,
      trustedSkills: skillIds.map((skillId) => ({
        capabilityId: `skill:${skillId}`,
        skillId,
        category: "built_in",
        lifecycleState: "trusted",
        trustLabel: "Built-in",
        source: "bundled",
        contentIntegrityManifestVersion: "goatcitadel.skill-tree.v1",
        treeSha256: "a".repeat(64),
        contentFileCount: 1,
        contentBytes: 10,
      })),
      activatedSkills: skillIds.map((skillId) => ({
        capabilityId: `skill:${skillId}`,
        skillId,
        confidence: 0.9,
        reasons: ["explicit_request"],
        treeSha256: "a".repeat(64),
        instructionSha256: "b".repeat(64),
        instructionBytes: 10,
        modules: [{ name: "main", relativePath: "SKILL.md", sha256: "c".repeat(64), bytes: 10 }],
      })),
    },
  };
  return { references, referenceSha256: "d".repeat(64) };
}

describe("design advisories on governed UI file writes", () => {
  async function writeHero(
    capabilityProfile: ChatTurnAgentRunnerInput["capabilityProfile"],
    overrides: Partial<ChatTurnAgentRunnerInput> = {},
  ) {
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
      input: turnInput({ capabilityProfile, ...overrides }),
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

  it.each(["bundled:impeccable", "bundled:design-intelligence"])(
    "attaches advisories from fresh %s admission without a frozen profile",
    async (skillId) => {
      const result = await writeHero(undefined, { featureAdmission: admissionWith([skillId]) });
      expect(result.record.status, JSON.stringify(result.record)).toBe("executed");
      expect(result.record.result?.designAdvisories).toEqual([
        expect.objectContaining({ ruleId: "gradient-text", line: 1, scope: "file" }),
      ]);
      expect(result.chunk?.type).toBe("tool_result");
      if (result.chunk?.type === "tool_result") {
        expect(result.chunk.toolRun.result?.designAdvisories).toEqual(result.record.result?.designAdvisories);
      }
    },
  );

  it("does not use trusted but unselected design skills or obsolete historical selection", async () => {
    const featureAdmission = admissionWith(["bundled:impeccable"]);
    featureAdmission.references.selectedSkills!.activatedSkills = [];
    const result = await writeHero(profileWith(["bundled:impeccable"]), { featureAdmission });
    expect(result.record.status).toBe("executed");
    expect(result.record.result).not.toHaveProperty("designAdvisories");
  });

  it("cannot dispatch a write after its canonical admission fence is revoked", async () => {
    const invokeTool = vi.fn(async (): Promise<ToolInvokeResult> => ({ outcome: "executed", result: {} }));
    const executeToolCall = createExecuteToolCallForTest({
      invokeTool,
      toolNames: ["fs.write"],
      evaluateToolAccess: vi.fn(async () => ({ allowed: true, requiresApproval: false, reasonCodes: ["allowed"] })),
    });
    await expect(
      executeToolCall({
        input: turnInput({
          featureAdmission: admissionWith(["bundled:impeccable"]),
          canonicalWriteFence: async () => {
            throw new Error("Admitted skill authority revoked");
          },
        }),
        turnId: "turn-design-revoked",
        toolName: "fs.write",
        rawArgs: { path: "src/hero.css", content: GRADIENT_CSS },
        localFileIntent: true,
      }),
    ).rejects.toThrow("Admitted skill authority revoked");
    expect(invokeTool).not.toHaveBeenCalled();
  });

  it("does not bypass a live policy denial for a fresh admitted design skill", async () => {
    const invokeTool = vi.fn(async (): Promise<ToolInvokeResult> => ({ outcome: "executed", result: {} }));
    const executeToolCall = createExecuteToolCallForTest({
      invokeTool,
      toolNames: ["fs.write"],
      evaluateToolAccess: vi.fn(async () => ({
        allowed: false,
        requiresApproval: false,
        reasonCodes: ["policy_deny"],
      })),
    });
    const result = await executeToolCall({
      input: turnInput({ featureAdmission: admissionWith(["bundled:impeccable"]) }),
      turnId: "turn-design-denied",
      toolName: "fs.write",
      rawArgs: { path: "src/hero.css", content: GRADIENT_CSS },
      localFileIntent: true,
    });
    expect(result.record.status).toBe("blocked");
    expect(result.record.result).not.toHaveProperty("designAdvisories");
    expect(invokeTool).not.toHaveBeenCalled();
  });

  it("keeps fresh admitted design writes neutral in the comparison harness", async () => {
    const result = await writeHero(undefined, {
      featureAdmission: admissionWith(["bundled:impeccable"]),
      normalizationProfile: "prompt_pack_harness",
    });
    expect(result.record.status).toBe("executed");
    expect(result.record.result).not.toHaveProperty("designAdvisories");
  });

  it("keeps the executed result when persisting the advisories fails", async () => {
    const storage = createMockStorage() as {
      chatToolRuns: { patch: (id: string, patch: Record<string, unknown>) => unknown };
    };
    const originalPatch = storage.chatToolRuns.patch.bind(storage.chatToolRuns);
    storage.chatToolRuns.patch = (toolRunId, patch) => {
      const result = patch.result as Record<string, unknown> | undefined;
      if (result && "designAdvisories" in result) throw new Error("canonical write fence closed");
      return originalPatch(toolRunId, patch);
    };
    const invokeTool = vi.fn(
      async (request: ToolInvokeRequest): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        result: { path: request.args.path, bytesWritten: GRADIENT_CSS.length },
      }),
    );
    const executeToolCall = createExecuteToolCallForTest({
      invokeTool,
      toolNames: ["fs.write"],
      storage: storage as never,
      evaluateToolAccess: vi.fn(async () => ({ allowed: true, requiresApproval: false, reasonCodes: ["allowed"] })),
    });

    const result = await executeToolCall({
      input: turnInput({ capabilityProfile: profileWith(["bundled:impeccable"]) }),
      turnId: "turn-design-advisories-fence",
      toolName: "fs.write",
      rawArgs: { path: "src/hero.css", content: GRADIENT_CSS },
      localFileIntent: true,
    });

    expect(result.record.status).toBe("executed");
    expect(result.record.result).not.toHaveProperty("designAdvisories");
  });

  it("skips advisories on eval-integrity turns so the harness stays neutral", async () => {
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

    const result = await executeToolCall({
      input: turnInput({
        capabilityProfile: profileWith(["bundled:impeccable"]),
        normalizationProfile: "prompt_pack_harness",
      }),
      turnId: "turn-design-advisories-eval",
      toolName: "fs.write",
      rawArgs: { path: "src/hero.css", content: GRADIENT_CSS },
      localFileIntent: true,
    });

    expect(result.record.status).toBe("executed");
    expect(result.record.result).not.toHaveProperty("designAdvisories");
  });

  it("leaves the result untouched without a design receipt", async () => {
    const result = await writeHero(profileWith(["bundled:coding"]));

    expect(result.record.status).toBe("executed");
    expect(result.record.result).not.toHaveProperty("designAdvisories");
  });
});

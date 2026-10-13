import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ToolInvokeRequest, ToolInvokeResult } from "@goatcitadel/contracts";
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

function profileWith(
  skillIds: string[],
  allowedTools: string[] = ["fs.write"],
): ChatTurnAgentRunnerInput["capabilityProfile"] {
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
      policyDecisions: allowedTools.map((toolName) => ({
        toolName,
        allowed: true,
        requiresApproval: false,
        reasonCodes: ["frozen_allowed"],
      })),
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

describe("model-authored html on documents.create", () => {
  const MODEL_HTML = "<!doctype html><html><head><title>Page</title></head><body><h1>Hi</h1></body></html>";

  async function createPage(
    capabilityProfile: ChatTurnAgentRunnerInput["capabilityProfile"],
    overrides: Partial<ChatTurnAgentRunnerInput> = {},
  ) {
    const invokeTool = vi.fn(
      async (request: ToolInvokeRequest): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        result: { path: request.args.path, bytesWritten: 10, format: "html" },
      }),
    );
    const executeToolCall = createExecuteToolCallForTest({
      invokeTool,
      toolNames: ["documents.create"],
      evaluateToolAccess: vi.fn(async () => ({ allowed: true, requiresApproval: false, reasonCodes: ["allowed"] })),
    });
    const result = await executeToolCall({
      input: turnInput({ capabilityProfile, content: "Build the landing page as an HTML document.", ...overrides }),
      turnId: "turn-model-html",
      toolName: "documents.create",
      rawArgs: { path: "./workspace/goatcitadel_out/page.html", format: "html", title: "Page", html: MODEL_HTML },
    });
    return { result, args: invokeTool.mock.calls[0]?.[0]?.args };
  }

  it("strips the html argument when the turn carries no design receipt", async () => {
    const { result, args } = await createPage(undefined);

    expect(result.record.status, JSON.stringify(result.record)).toBe("executed");
    expect(args).toBeDefined();
    expect(args).not.toHaveProperty("html");
    expect(args?.design).toMatchObject({ mode: "polished" });
  });

  it("strips the html argument on an eval-integrity turn that carries no design receipt", async () => {
    const { result, args } = await createPage(undefined, { normalizationProfile: "prompt_pack_harness" });

    expect(result.record.status, JSON.stringify(result.record)).toBe("executed");
    expect(args).toBeDefined();
    expect(args).not.toHaveProperty("html");
  });

  it("keeps the html argument under an impeccable receipt", async () => {
    const { result, args } = await createPage(profileWith(["bundled:impeccable"], ["documents.create"]));

    expect(result.record.status, JSON.stringify(result.record)).toBe("executed");
    expect(args?.html).toBe(MODEL_HTML);
  });
});

import { describe, expect, it, vi } from "vitest";
import type { ChatToolRunRecord, ToolCatalogEntry } from "@goatcitadel/contracts";
import {
  ChatTurnAgentRunner,
  type ChatTurnAgentRunnerInput,
  type ResolvedChatTurnToolSchema,
} from "./chat-turn-agent-runner.js";
import { createMockStorage } from "./chat-turn-agent-runner-test-fixtures.js";
import { estimateSerializedProviderSchemaTokens } from "./chat-tool-schema-budget.js";

function input(content = "Help me choose a suitable capability"): ChatTurnAgentRunnerInput {
  return {
    sessionId: "session",
    turnId: "turn",
    userMessageId: "message",
    content,
    mode: "chat",
    providerId: "fixture",
    model: "fixture",
    webMode: "auto",
    memoryMode: "off",
    thinkingLevel: "standard",
    toolAutonomy: "safe_auto",
    historyMessages: [{ role: "user", content }],
    executionProfile: "standard",
  };
}
function tool(toolName: string, description = "Useful operation"): ToolCatalogEntry {
  return {
    toolName,
    description,
    category: "knowledge",
    pack: "core",
    riskLevel: "safe",
    requiresApproval: false,
    argSchema: { type: "object", properties: {} },
    examples: [],
  };
}
function harness(enabled = true) {
  const denied = new Set<string>();
  const catalog = [
    tool("capabilities.search"),
    tool("skills.read"),
    tool("time.now"),
    tool("browser.search"),
    ...Array.from({ length: 16 }, (_, index) => tool(`fixture.tool_${String(index).padStart(2, "0")}`)),
  ];
  const inspectToolAccess = vi.fn(async ({ toolName }: { toolName: string }) => ({
    allowed: !denied.has(toolName),
    requiresApproval: toolName === "fixture.tool_15",
    reasonCodes: denied.has(toolName) ? ["explicit_deny"] : [],
  }));
  const observeToolSchemaSelection = vi.fn();
  const runner = new ChatTurnAgentRunner({
    storage: createMockStorage() as never,
    listToolCatalog: () => catalog,
    boundedToolExposureV1Enabled: async () => enabled,
    inspectToolAccess,
    observeToolSchemaSelection,
    createChatCompletion: vi.fn(),
    invokeTool: vi.fn(),
  });
  return { runner, denied, catalog, inspectToolAccess, observeToolSchemaSelection };
}

describe("ordinary Chat bounded tool exposure", () => {
  it("selects eight actual schemas with essential discovery and retains opt-out behavior", async () => {
    const { runner, observeToolSchemaSelection } = harness();
    const schema = await runner.resolveCapabilityToolSchema(input());
    expect(schema.tools).toHaveLength(8);
    expect(schema.canonicalToModel.has("capabilities.search")).toBe(true);
    expect(schema.canonicalToModel.has("skills.read")).toBe(true);
    expect(schema.selectionDiagnostics?.estimatedSchemaTokens).toBe(
      estimateSerializedProviderSchemaTokens(schema.tools),
    );
    expect(observeToolSchemaSelection).toHaveBeenCalledOnce();
    const legacy = await harness(false).runner.resolveCapabilityToolSchema(input());
    expect(legacy.tools.length).toBeGreaterThan(8);
    expect(legacy.canonicalToModel.has("capabilities.search")).toBe(false);
    expect(legacy.selectionDiagnostics).toBeUndefined();
  });

  it("retains explicit tools beyond the soft cap and excludes current deny-wins removals", async () => {
    const { runner, denied } = harness();
    denied.add("fixture.tool_15");
    const schema = await runner.resolveCapabilityToolSchema(
      input(Array.from({ length: 16 }, (_, index) => `fixture.tool_${String(index).padStart(2, "0")}`).join(" ")),
    );
    expect(schema.tools.length).toBeGreaterThan(8);
    expect(schema.selectionDiagnostics?.exceededToolCap).toBe(true);
    expect(schema.canonicalToModel.has("fixture.tool_15")).toBe(false);
  });

  it("nominates deferred discovery tools only after a fresh policy pass, including resume", async () => {
    const { runner, denied, inspectToolAccess } = harness();
    const turn = input();
    const schema = await runner.resolveCapabilityToolSchema(turn);
    expect(schema.canonicalToModel.has("fixture.tool_15")).toBe(false);
    const refresh = (run: ChatToolRunRecord) =>
      (
        runner as unknown as {
          refreshDiscoveredToolSchema(
            input: ChatTurnAgentRunnerInput,
            schema: ResolvedChatTurnToolSchema,
            run: ChatToolRunRecord,
          ): Promise<void>;
        }
      ).refreshDiscoveredToolSchema(turn, schema, run);
    const run: ChatToolRunRecord = {
      toolRunId: "search",
      sessionId: "session",
      turnId: "turn",
      toolName: "capabilities.search",
      status: "executed",
      startedAt: new Date().toISOString(),
      result: {
        discoveryOnly: true,
        capabilities: [
          { kind: "tool", toolName: "fixture.tool_15" },
          { kind: "tool", toolName: "unregistered.run" },
        ],
      },
    };
    await refresh(run);
    expect(schema.canonicalToModel.has("fixture.tool_15")).toBe(true);
    expect(schema.canonicalToModel.has("unregistered.run")).toBe(false);
    expect(schema.policyDecisions.find((entry) => entry.toolName === "fixture.tool_15")?.requiresApproval).toBe(true);
    denied.add("fixture.tool_15");
    const probesBefore = inspectToolAccess.mock.calls.length;
    await refresh(run);
    expect(inspectToolAccess.mock.calls.length).toBeGreaterThan(probesBefore);
    expect(schema.canonicalToModel.has("fixture.tool_15")).toBe(false);
    await refresh({ ...run, sessionId: "other" });
    expect(schema.canonicalToModel.has("fixture.tool_15")).toBe(false);
  });

  it("keeps quick-web and manual turns outside the new discovery exposure", async () => {
    const { runner } = harness();
    const quick = await runner.resolveCapabilityToolSchema({
      ...input("Find current weather"),
      executionProfile: "quick_web",
    });
    expect([...quick.canonicalToModel.keys()]).toEqual(["browser.search"]);
    expect(quick.selectionDiagnostics).toBeUndefined();
    expect((await runner.resolveCapabilityToolSchema({ ...input(), toolAutonomy: "manual" })).tools).toEqual([]);
  });
});

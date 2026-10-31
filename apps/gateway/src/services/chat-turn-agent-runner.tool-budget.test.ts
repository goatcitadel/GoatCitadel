import { describe, expect, it, vi } from "vitest";
import {
  HEARTBEAT_PERMISSION_PROFILE_ID,
  SCHEDULED_TURN_PERMISSION_PROFILE_ID,
  type ChatToolRunRecord,
  type CodeModeReadiness,
  type ToolCatalogEntry,
} from "@goatcitadel/contracts";
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

describe("code_mode.request exposure", () => {
  function codeModeHarness(readiness: CodeModeReadiness | undefined) {
    const catalog = [
      tool("capabilities.search"),
      tool("skills.read"),
      tool("time.now"),
      { ...tool("code_mode.request", "Ask the operator to run a short script"), requiresApproval: true },
      ...Array.from({ length: 16 }, (_, index) => tool(`fixture.tool_${String(index).padStart(2, "0")}`)),
    ];
    const getCodeModeReadiness = vi.fn(async () => readiness!);
    const runner = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => catalog,
      boundedToolExposureV1Enabled: async () => true,
      inspectToolAccess: vi.fn(async ({ toolName }: { toolName: string }) => ({
        allowed: true,
        requiresApproval: toolName === "code_mode.request",
        reasonCodes: [],
      })),
      ...(readiness ? { getCodeModeReadiness } : {}),
      createChatCompletion: vi.fn(),
      invokeTool: vi.fn(),
    });
    return { runner, getCodeModeReadiness };
  }
  const ready: CodeModeReadiness = { enabled: true, sandboxEnabled: true, sandboxSupported: true, canRun: true };
  const off = (reason: NonNullable<CodeModeReadiness["reason"]>): CodeModeReadiness => ({
    enabled: reason !== "code_mode_off",
    sandboxEnabled: reason === "code_mode_off",
    sandboxSupported: reason !== "sandbox_unsupported",
    canRun: false,
    reason,
  });
  async function exposed(readiness: CodeModeReadiness | undefined, overrides: Partial<ChatTurnAgentRunnerInput> = {}) {
    const schema = await codeModeHarness(readiness).runner.resolveCapabilityToolSchema({ ...input(), ...overrides });
    return { schema, exposed: schema.canonicalToModel.has("code_mode.request") };
  }

  it("exposes code_mode.request as essential in chat when Code Mode can run or can be turned on", async () => {
    const whenReady = await exposed(ready);
    expect(whenReady.exposed).toBe(true);
    // Essentials count toward the cap, so the schema stays at eight.
    expect(whenReady.schema.tools).toHaveLength(8);
    expect((await exposed(off("code_mode_off"), { authActorSource: "loopback" })).exposed).toBe(true);
    expect((await exposed(off("sandbox_off"), { authActorSource: "token" })).exposed).toBe(true);
    expect((await exposed(ready, { authActorSource: "device" })).exposed).toBe(true);
  });

  it("keeps code_mode.request away from turns that cannot approve or run it", async () => {
    expect((await exposed(off("sandbox_unsupported"), { authActorSource: "loopback" })).exposed).toBe(false);
    expect((await exposed(off("code_mode_off"))).exposed).toBe(false);
    expect((await exposed(off("code_mode_off"), { authActorSource: "companion" })).exposed).toBe(false);
    expect((await exposed(ready, { authActorSource: "companion" })).exposed).toBe(false);
    expect((await exposed(ready, { authActorSource: "a2a_peer" })).exposed).toBe(false);
    expect((await exposed(ready, { parentDelegationStepId: "delegation-step-1" })).exposed).toBe(false);
    expect((await exposed(ready, { toolAutonomy: "manual" })).exposed).toBe(false);
    expect((await exposed(ready, { mode: "code" })).exposed).toBe(false);
    expect((await exposed(undefined)).exposed).toBe(false);
  });

  it("never offers the turn-on path on a machine that cannot run the sandbox", async () => {
    const unsupportedButOff: CodeModeReadiness = {
      enabled: false,
      sandboxEnabled: false,
      sandboxSupported: false,
      canRun: false,
      reason: "code_mode_off",
    };
    expect((await exposed(unsupportedButOff, { authActorSource: "loopback" })).exposed).toBe(false);
  });

  it("keeps code_mode.request away from server-only, scheduled, heartbeat and mesh turns", async () => {
    expect((await exposed(ready, { serverOnlyPosture: true })).exposed).toBe(false);
    expect((await exposed(ready, { permissionProfileId: SCHEDULED_TURN_PERMISSION_PROFILE_ID })).exposed).toBe(false);
    expect((await exposed(ready, { permissionProfileId: HEARTBEAT_PERMISSION_PROFILE_ID })).exposed).toBe(false);
    expect((await exposed(ready, { authActorSource: "mesh_node" })).exposed).toBe(false);
  });

  it("does not offer code_mode.request when the readiness read fails", async () => {
    const { runner, getCodeModeReadiness } = codeModeHarness(ready);
    getCodeModeReadiness.mockRejectedValueOnce(new Error("readiness unavailable"));
    const schema = await runner.resolveCapabilityToolSchema({ ...input(), authActorSource: "loopback" });
    expect(schema.canonicalToModel.has("code_mode.request")).toBe(false);
  });

  it("reads Code Mode readiness once per tool schema", async () => {
    const { runner, getCodeModeReadiness } = codeModeHarness(ready);
    await runner.resolveCapabilityToolSchema(input());
    expect(getCodeModeReadiness).toHaveBeenCalledTimes(1);
  });
});

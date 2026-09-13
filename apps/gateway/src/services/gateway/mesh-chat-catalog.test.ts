import { describe, expect, it, vi } from "vitest";
import { type CapabilityCatalogEntry, type MeshCapabilityManifest } from "@goatcitadel/contracts";
import { ChatTurnAgentRunner, type ChatTurnAgentRunnerDeps, type ChatTurnAgentRunnerInput } from "../chat-turn-agent-runner.js";
import { createMockStorage, createToolCatalog } from "../chat-turn-agent-runner-test-fixtures.js";
import { createMeshChatCatalogFixture } from "./mesh-chat-catalog-test-fixtures.js";
import { assertMeshChatToolSchema, MESH_CHAT_CATALOG_LIMIT, resolveMeshChatToolSchemas } from "./mesh-chat-catalog.js";

const input: ChatTurnAgentRunnerInput = {
  sessionId: "session-schema", turnId: "turn-schema", userMessageId: "message-schema",
  content: "Use the published project status capability.", mode: "chat", providerId: "fixture", model: "fixture",
  webMode: "auto", memoryMode: "off", retrievalMode: "standard", thinkingLevel: "standard", speedMode: "standard",
  subagentPolicy: "off", toolAutonomy: "safe_auto", operatorId: "operator", authActorId: "operator",
  authActorSource: "token", permissionProfileId: "safe", historyMessages: [],
};

function createRunner(overrides: Partial<ChatTurnAgentRunnerDeps> = {}) {
  return new ChatTurnAgentRunner({
    storage: createMockStorage() as ChatTurnAgentRunnerDeps["storage"],
    listToolCatalog: () => [], createChatCompletion: vi.fn(), invokeTool: vi.fn(), ...overrides,
  });
}

describe("mesh Chat schema admission", () => {
  it.each(["tool", "mcp_server"] as const)("admits the exact %s definition behind a non-serializable policy handle", async (kind) => {
    const fixture = createMeshChatCatalogFixture({ kind, nodeId: "mini:α:pc" });
    const [schema] = await resolveMeshChatToolSchemas(fixture.deps, {
      workspaceId: fixture.workspaceId, entries: [fixture.entry],
    });
    expect(schema!.canonicalName).toBe(fixture.capabilityId);
    expect(schema!.modelName).toMatch(/^mesh_[a-f0-9]{56}$/u);
    expect(schema!.publication).toEqual(fixture.binding);
    expect(schema!.entry.effectPotential).toMatchObject({ potential: "unknown", sourceKind: "remote" });
    expect(() => assertMeshChatToolSchema(schema!)).not.toThrow();
    expect(() => assertMeshChatToolSchema({ ...schema! })).toThrow("not server-owned");
    expect(() => JSON.stringify(schema)).toThrow("cannot be serialized");
    const definition = schema!.providerDefinition.function as { parameters: Record<string, unknown> };
    expect(Object.isFrozen(definition.parameters)).toBe(true);
    if (fixture.publication.descriptor.kind === "tool") {
      expect(definition.parameters).toEqual(fixture.publication.descriptor.inputSchema);
      fixture.publication.descriptor.inputSchema.injected = true;
      expect(definition.parameters).not.toHaveProperty("injected");
    } else {
      expect(definition.parameters).toEqual({ type: "object", properties: {
        toolName: { type: "string", enum: ["project.status", "project.search"] },
        arguments: { type: "object", additionalProperties: true },
      }, required: ["toolName", "arguments"], additionalProperties: false });
    }
  });

  it("changes the provider alias when activation authority changes", async () => {
    const fixture = createMeshChatCatalogFixture();
    const request = { workspaceId: fixture.workspaceId, entries: [fixture.entry] };
    const [before] = await resolveMeshChatToolSchemas(fixture.deps, request);
    fixture.binding.healthGeneration += 1;
    const [after] = await resolveMeshChatToolSchemas(fixture.deps, request);
    expect(after!.canonicalName).toBe(before!.canonicalName);
    expect(after!.modelName).not.toBe(before!.modelName);
  });

  it.each([
    ["workspace", (manifest: MeshCapabilityManifest) => { manifest.workspaceId = "another-workspace"; }],
    ["node", (manifest: MeshCapabilityManifest) => { manifest.nodeId = "another-node"; }],
    ["admission", (manifest: MeshCapabilityManifest) => { manifest.admissionGeneration += 1; }],
    ["generation", (manifest: MeshCapabilityManifest) => { manifest.publisherGeneration += 1; }],
    ["manifest", (manifest: MeshCapabilityManifest) => { manifest.manifestSha256 = "0".repeat(64); }],
    ["entry", (manifest: MeshCapabilityManifest) => { manifest.entries[0]!.entrySha256 = "0".repeat(64); }],
    ["posture", (manifest: MeshCapabilityManifest) => { manifest.entries[0]!.descriptor.effectPosture = "unknown"; }],
  ])("rejects a repository result with mismatched %s identity", async (_name, mutate) => {
    const fixture = createMeshChatCatalogFixture();
    mutate(fixture.manifest);
    await expect(resolveMeshChatToolSchemas(fixture.deps, {
      workspaceId: fixture.workspaceId, entries: [fixture.entry],
    })).rejects.toThrow("mesh_capability_freeze_drift");
  });

  it.each(["permissions", "revocation", "activation"])("rejects current %s drift after descriptor loading", async (variant) => {
    const fixture = createMeshChatCatalogFixture();
    if (variant === "permissions") fixture.binding.permissionEnvelopeSha256 = "0".repeat(64);
    if (variant === "revocation") fixture.deps.activations.resolveProfileBindings = async () => new Map();
    if (variant === "activation") fixture.entry.mesh!.activation = {
      activationId: fixture.binding.activationId, activationRevision: fixture.binding.activationRevision + 1,
      approvalId: "fixture-approval", revoked: false,
    };
    await expect(resolveMeshChatToolSchemas(fixture.deps, {
      workspaceId: fixture.workspaceId, entries: [fixture.entry],
    })).rejects.toThrow("mesh_capability_freeze_drift");
  });

  it("excludes inactive entries and skill descriptors without consulting runtime owners", async () => {
    const fixture = createMeshChatCatalogFixture();
    const read = vi.spyOn(fixture.deps.storage.meshCapabilityPublications, "getManifest");
    const bindings = vi.spyOn(fixture.deps.activations, "resolveProfileBindings");
    const skill: CapabilityCatalogEntry = { ...fixture.entry, kind: "mesh_skill" };
    expect(await resolveMeshChatToolSchemas(fixture.deps, {
      workspaceId: fixture.workspaceId, entries: [skill, { ...fixture.entry, callable: false }],
    })).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    expect(bindings).not.toHaveBeenCalled();
  });

  it("rejects duplicate identities before any descriptor or authority reads", async () => {
    const fixture = createMeshChatCatalogFixture();
    const read = vi.spyOn(fixture.deps.storage.meshCapabilityPublications, "getManifest");
    await expect(resolveMeshChatToolSchemas(fixture.deps, {
      workspaceId: fixture.workspaceId, entries: [fixture.entry, fixture.entry],
    })).rejects.toThrow("mesh_capability_freeze_drift");
    expect(read).not.toHaveBeenCalled();
  });

  it("shares a bounded inventory across nodes and uses one current-authority batch", async () => {
    const fixtures = Array.from({ length: MESH_CHAT_CATALOG_LIMIT + 2 }, (_, index) =>
      createMeshChatCatalogFixture({ nodeId: index === 0 ? "small-node" : "large-node", localId: `tool-${index}` }));
    const manifests = new Map(fixtures.map((fixture) => [fixture.manifest.manifestSha256, fixture.manifest]));
    const bindingByName = new Map(fixtures.map((fixture) => [fixture.capabilityId, fixture.binding]));
    const getManifest = vi.fn(async (_workspace: string, _node: string, _generation: number, hash: string) => manifests.get(hash)!);
    const resolveBindings = vi.fn(async () => bindingByName);
    const result = await resolveMeshChatToolSchemas({
      storage: { meshCapabilityPublications: { getManifest } }, activations: { resolveProfileBindings: resolveBindings },
    }, { workspaceId: "workspace-1", entries: fixtures.map((fixture) => fixture.entry) });
    expect(result).toHaveLength(MESH_CHAT_CATALOG_LIMIT);
    expect(result.some((schema) => schema.publication.nodeId === "small-node")).toBe(true);
    expect(getManifest).toHaveBeenCalledTimes(MESH_CHAT_CATALOG_LIMIT);
    expect(resolveBindings).toHaveBeenCalledOnce();
  });

  it("admits a mesh definition through the runner's exact policy probe and allow-map", async () => {
    const fixture = createMeshChatCatalogFixture();
    const schemas = await resolveMeshChatToolSchemas(fixture.deps, { workspaceId: fixture.workspaceId, entries: [fixture.entry] });
    const inspect = vi.fn(async () => ({ allowed: true, requiresApproval: true, reasonCodes: ["approval_required"] }));
    const runner = createRunner({ inspectToolAccess: inspect });
    const result = await runner.resolveCapabilityToolSchema(input, [], schemas);
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ toolName: fixture.capabilityId }), {
      meshCatalogPolicyBinding: schemas[0]!.policyBinding,
    });
    expect(result.tools).toEqual([schemas[0]!.providerDefinition]);
    expect(result.modelToCanonical.get(schemas[0]!.modelName)).toBe(fixture.capabilityId);
    expect(result.canonicalToModel.has("mesh.invoke")).toBe(false);
    expect(result.policyDecisions).toEqual([{ toolName: fixture.capabilityId, allowed: true,
      requiresApproval: true, reasonCodes: ["approval_required"] }]);
  });

  it.each(["missing", "denied", "failed"])("does not expose a mesh definition with %s policy authority", async (mode) => {
    const fixture = createMeshChatCatalogFixture();
    const schemas = await resolveMeshChatToolSchemas(fixture.deps, { workspaceId: fixture.workspaceId, entries: [fixture.entry] });
    const runner = createRunner(mode === "missing" ? {} : { inspectToolAccess: async () => {
      if (mode === "failed") throw new Error("Unavailable owner");
      return { allowed: false, requiresApproval: false, reasonCodes: ["denied"] };
    } });
    expect((await runner.resolveCapabilityToolSchema(input, [], schemas)).tools).toEqual([]);
  });

  it("keeps policy handles out of invocation ports and rejects a registered-name collision", async () => {
    const fixture = createMeshChatCatalogFixture();
    const schemas = await resolveMeshChatToolSchemas(fixture.deps, { workspaceId: fixture.workspaceId, entries: [fixture.entry] });
    const invokeTool = vi.fn();
    const runner = createRunner({ invokeTool, listToolCatalog: () => [
      { ...createToolCatalog(["browser.search"])[0]!, toolName: fixture.capabilityId },
    ] });
    await expect(runner.resolveCapabilityToolSchema(input, [], schemas)).rejects.toThrow("collides");
    expect(invokeTool).not.toHaveBeenCalled();
  });
});

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalJsonString,
  type ChatTurnFeatureReferences,
  type ToolAccessEvaluateRequest,
} from "@goatcitadel/contracts";
import type { ActiveTurnAdmission } from "./chat-turn-types.js";
import { createMeshChatCatalogFixture } from "./gateway/mesh-chat-catalog-test-fixtures.js";
import { resolveMeshChatToolSchemas } from "./gateway/mesh-chat-catalog.js";
import {
  createMeshAdmissionTurnContext,
  readMeshAdmissionTurnContext,
  resolveMeshChatToolBinding,
} from "./gateway/mesh-chat-binding.js";
import {
  buildSelectedMeshAdmission,
  restoreSelectedMeshAdmission,
  selectMeshAdmissionCandidates,
  selectCallableMeshChatAdmission,
  type ChatMeshAdmissionHost,
} from "./chat-mesh-admission-service.js";

const hash = (value: unknown) => createHash("sha256").update(canonicalJsonString(value)).digest("hex");
async function fixture() {
  const mesh = createMeshChatCatalogFixture();
  const scope = {
    admissionId: "admission",
    sessionIncarnationId: "incarnation",
    workspaceId: mesh.workspaceId,
    sessionId: "session",
    turnId: "turn",
    aggregateRevision: 1,
    controllerGeneration: 1,
    materialSha256: "a".repeat(64),
    actorId: "actor",
    actorSource: "token" as const,
  };
  const schemas = await resolveMeshChatToolSchemas(mesh.deps, { workspaceId: mesh.workspaceId, entries: [mesh.entry] });
  const references: ChatTurnFeatureReferences = {
    version: "chat.turn.feature-references.v1",
    selectedMeshCapabilities: buildSelectedMeshAdmission(scope, schemas),
  };
  const binding = { references, referenceSha256: hash(references) };
  const assertCurrent = vi.fn(async () => undefined);
  const handle = createMeshAdmissionTurnContext(scope, binding.referenceSha256, assertCurrent);
  const host: ChatMeshAdmissionHost = {
    ...mesh.deps,
    enabled: vi.fn(async () => true),
    assertScopeCurrent: vi.fn(async () => undefined),
    readAdmission: vi.fn(async () => binding),
    listCallable: vi.fn(async () => [mesh.entry]),
  };
  return { ...mesh, scope, schemas, binding, assertCurrent, handle, host };
}

describe("selected mesh feature admission", () => {
  it("filters denied schemas and rechecks the admission after policy inspection", async () => {
    const f = await fixture();
    let current = true;
    const assertTurnAdmissionWrite = vi.fn(async () => {
      if (!current) throw new Error("claim revoked");
    });
    const host = {
      assertTurnAdmissionWrite,
      listCallable: async () => [f.entry],
      resolveSchemas: async () => f.schemas,
      prepareToolAccessEvaluation: vi.fn(async (request: ToolAccessEvaluateRequest) => request),
      inspectSchemaAccess: vi.fn(async () => ({ allowed: false })),
    };
    const input = {
      content: f.capabilityId,
      admission: {
        identity: f.scope,
        requestActor: { authActorId: f.scope.actorId, authActorSource: f.scope.actorSource },
      } as ActiveTurnAdmission,
    };
    expect(await selectCallableMeshChatAdmission(host, input)).toBeUndefined();
    expect(host.prepareToolAccessEvaluation).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: f.scope.workspaceId,
        policyContext: {
          authActorId: f.scope.actorId,
          authActorSource: f.scope.actorSource,
          workspaceId: f.scope.workspaceId,
        },
      }),
    );
    host.inspectSchemaAccess.mockResolvedValueOnce({ allowed: true });
    expect(await selectCallableMeshChatAdmission(host, input)).toEqual(f.binding.references.selectedMeshCapabilities);
    host.inspectSchemaAccess.mockImplementationOnce(async () => {
      current = false;
      return { allowed: true };
    });
    await expect(selectCallableMeshChatAdmission(host, input)).rejects.toThrow("claim revoked");
  });
  it("restores only selected publication identities and exact provider schemas without a profile", async () => {
    const f = await fixture();
    const restored = await restoreSelectedMeshAdmission(f.host, f.handle);
    expect(restored.map((schema) => schema.modelName)).toEqual(f.schemas.map((schema) => schema.modelName));
    expect(JSON.stringify(f.binding.references)).not.toContain("callableCatalog");
    const binding = await resolveMeshChatToolBinding(
      {
        ...f.deps,
        storage: f.deps.storage as never,
        restoreAdmissionSchemas: (handle) => restoreSelectedMeshAdmission(f.host, handle),
      },
      {
        toolName: f.capabilityId,
        sessionId: "session",
        workspaceId: f.workspaceId,
        turnId: "turn",
        args: {},
        agentId: "assistant",
        policyContext: { authActorId: "actor", authActorSource: "token" },
      },
      f.handle,
    );
    expect(binding?.executionProfileSha256).toBe(f.binding.referenceSha256);
    expect(binding?.schema.canonicalName).toBe(f.capabilityId);
  });
  it.each(["health", "activation", "publication", "callable", "hash", "claim", "flag"])(
    "refuses %s drift before reusing a selected mesh schema",
    async (drift) => {
      const f = await fixture();
      if (drift === "health")
        f.deps.activations.resolveProfileBindings = async () =>
          new Map([[f.capabilityId, { ...f.schemas[0]!.publication, healthGeneration: 99 }]]);
      if (drift === "activation") f.deps.activations.resolveProfileBindings = async () => new Map();
      if (drift === "publication") f.manifest.publisherGeneration++;
      if (drift === "callable") f.entry.callable = false;
      if (drift === "hash") f.binding.referenceSha256 = "0".repeat(64);
      if (drift === "claim") f.assertCurrent.mockRejectedValue(new Error("claim lost"));
      if (drift === "flag") f.host.enabled = async () => false;
      await expect(restoreSelectedMeshAdmission(f.host, f.handle)).rejects.toThrow();
    },
  );
  it("rejects copied handles and cross-actor native binding", async () => {
    const f = await fixture();
    expect(readMeshAdmissionTurnContext({ ...f.handle })).toBeUndefined();
    expect(() => JSON.stringify(f.handle)).toThrow();
    await expect(
      resolveMeshChatToolBinding(
        {
          ...f.deps,
          storage: f.deps.storage as never,
          restoreAdmissionSchemas: (handle) => restoreSelectedMeshAdmission(f.host, handle),
        },
        {
          toolName: f.capabilityId,
          sessionId: "session",
          workspaceId: f.workspaceId,
          args: {},
          agentId: "assistant",
          policyContext: { authActorId: "foreign", authActorSource: "token" },
        },
        f.handle,
      ),
    ).rejects.toThrow();
  });
  it("bounds metadata nominations and excludes inactive skills and unrelated capabilities", async () => {
    const f = await fixture();
    expect(selectMeshAdmissionCandidates([f.entry], "Please check project status")).toEqual([f.entry]);
    expect(selectMeshAdmissionCandidates([f.entry], "Write a poem")).toEqual([]);
    expect(
      selectMeshAdmissionCandidates(
        [
          { ...f.entry, callable: false },
          { ...f.entry, kind: "mesh_skill" },
        ],
        f.capabilityId,
      ),
    ).toEqual([]);
    const many = Array.from({ length: 20 }, (_, index) => ({ ...f.entry, capabilityId: `${f.capabilityId}-${index}` }));
    expect(selectMeshAdmissionCandidates(many, "Project status")).toHaveLength(5);
  });
});

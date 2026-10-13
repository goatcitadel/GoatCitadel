import { createHash } from "node:crypto";
import {
  canonicalJsonString,
  chatSelectedMeshCapabilitiesSchema,
  readChatTurnFeatureReferences,
  type CapabilityCatalogEntry,
  type ChatSelectedMeshCapabilities,
  type ChatTurnFeatureReferences,
  type McpRequesterAdmissionScope,
  type ToolAccessEvaluateRequest,
} from "@goatcitadel/contracts";
import type { ActiveTurnAdmission } from "./chat-turn-types.js";
import { requesterScopeFromActiveAdmission } from "./mcp-requester-admission-scope.js";
import {
  assertMeshChatToolSchema,
  resolveMeshChatToolSchemas,
  type MeshChatToolSchema,
} from "./gateway/mesh-chat-catalog.js";
import { readMeshAdmissionTurnContext, type MeshChatTurnContextHandle } from "./gateway/mesh-chat-binding.js";
import { ToolExecutionPreconditionError } from "@goatcitadel/policy-engine";
import type { ToolInvokeRequest } from "@goatcitadel/contracts";

/** Live dispatch binding retains exact actor/turn scope and current schema receipts. */
export async function resolveAdmittedMeshToolBinding(
  deps: { restoreAdmissionSchemas?: (handle: MeshChatTurnContextHandle) => Promise<MeshChatToolSchema[]> },
  request: ToolAccessEvaluateRequest & Partial<Pick<ToolInvokeRequest, "turnId">>,
  context: { scope: McpRequesterAdmissionScope; referenceSha256: string; assertCurrent(): Promise<void> },
  handle: MeshChatTurnContextHandle,
) {
  const invalid = (): never => { throw new ToolExecutionPreconditionError("Mesh tool requires its exact current frozen Chat capability binding"); };
  if (!deps.restoreAdmissionSchemas || request.sessionId !== context.scope.sessionId ||
      request.workspaceId !== context.scope.workspaceId || request.policyContext?.authActorId !== context.scope.actorId ||
      request.policyContext.authActorSource !== context.scope.actorSource ||
      (request.turnId !== undefined && request.turnId !== context.scope.turnId)) return invalid();
  await context.assertCurrent();
  const schemas = await deps.restoreAdmissionSchemas(handle);
  const matched = schemas.filter((schema) => schema.canonicalName === request.toolName);
  if (matched.length !== 1) invalid();
  return Object.freeze({ schema: matched[0]!, executionProfileSha256: context.referenceSha256 });
}

const digest = (value: unknown) => createHash("sha256").update(canonicalJsonString(value)).digest("hex");

export async function selectCallableMeshChatAdmission(
  host: {
    assertTurnAdmissionWrite(admission: ActiveTurnAdmission): Promise<void>;
    listCallable(workspaceId: string): Promise<CapabilityCatalogEntry[]>;
    resolveSchemas(input: {
      workspaceId: string;
      entries: readonly CapabilityCatalogEntry[];
    }): Promise<MeshChatToolSchema[]>;
    prepareToolAccessEvaluation(input: ToolAccessEvaluateRequest): Promise<ToolAccessEvaluateRequest>;
    inspectSchemaAccess(request: ToolAccessEvaluateRequest, schema: MeshChatToolSchema): Promise<{ allowed: boolean }>;
  },
  input: { admission: ActiveTurnAdmission; content: string },
) {
  await host.assertTurnAdmissionWrite(input.admission);
  const workspaceId = input.admission.identity.workspaceId;
  const candidates = selectMeshAdmissionCandidates(await host.listCallable(workspaceId), input.content);
  if (!candidates.length) return undefined;
  const scope = requesterScopeFromActiveAdmission(input.admission);
  const schemas = await host.resolveSchemas({ workspaceId, entries: candidates }),
    selected = [];
  for (const schema of schemas) {
    const request = await host.prepareToolAccessEvaluation({
      toolName: schema.canonicalName,
      args: {},
      agentId: "assistant",
      workspaceId,
      sessionId: scope.sessionId,
      surface: "chat",
      policyContext: { authActorId: scope.actorId, authActorSource: scope.actorSource, workspaceId },
    });
    if ((await host.inspectSchemaAccess(request, schema)).allowed) selected.push(schema);
  }
  await host.assertTurnAdmissionWrite(input.admission);
  return selected.length ? buildSelectedMeshAdmission(scope, selected) : undefined;
}

/** Bounded metadata nomination only. Active publication, policy and approvals decide availability. */
export function selectMeshAdmissionCandidates(
  entries: readonly CapabilityCatalogEntry[],
  content: string,
): CapabilityCatalogEntry[] {
  const query = new Set((content.toLowerCase().match(/[a-z0-9_-]{3,}/gu) ?? []).slice(0, 128));
  return entries
    .filter((entry) => entry.callable && (entry.kind === "mesh_tool" || entry.kind === "mesh_mcp_server"))
    .map((entry) => {
      const terms = new Set(`${entry.title} ${entry.summary ?? ""}`.toLowerCase().match(/[a-z0-9_-]{3,}/gu) ?? []);
      const matches = [...query].filter((term) => terms.has(term)).length;
      return { entry, score: content.includes(entry.capabilityId) ? 1000 : matches >= 2 ? matches : 0 };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.entry.capabilityId.localeCompare(b.entry.capabilityId))
    .slice(0, 5)
    .map(({ entry }) => entry);
}

export function buildSelectedMeshAdmission(
  scope: McpRequesterAdmissionScope,
  schemas: readonly MeshChatToolSchema[],
): ChatSelectedMeshCapabilities {
  for (const schema of schemas) assertMeshChatToolSchema(schema);
  return chatSelectedMeshCapabilitiesSchema.parse({
    version: "chat.mesh.admission.v1",
    scope,
    selected: schemas.map((schema) => ({
      capabilityId: schema.canonicalName,
      modelName: schema.modelName,
      providerDefinitionSha256: digest(schema.providerDefinition),
      publication: schema.publication,
    })),
  });
}

export type ChatMeshAdmissionHost = Parameters<typeof resolveMeshChatToolSchemas>[0] & {
  enabled(): Promise<boolean>;
  assertScopeCurrent(scope: McpRequesterAdmissionScope): Promise<void>;
  readAdmission(
    scope: McpRequesterAdmissionScope,
  ): Promise<{ references: ChatTurnFeatureReferences; referenceSha256: string } | undefined>;
  listCallable(workspaceId: string): Promise<CapabilityCatalogEntry[]>;
};

/** Reconstruct selected schemas through the existing publication and activation owners; no stored catalog exists. */
export async function restoreSelectedMeshAdmission(
  host: ChatMeshAdmissionHost,
  handle: MeshChatTurnContextHandle,
): Promise<MeshChatToolSchema[]> {
  const context = readMeshAdmissionTurnContext(handle);
  if (!context || !(await host.enabled())) throw new Error("Admitted mesh capabilities are unavailable.");
  await context.assertCurrent();
  await host.assertScopeCurrent(context.scope);
  const binding = await host.readAdmission(context.scope);
  if (!binding || binding.referenceSha256 !== context.referenceSha256)
    throw new Error("Mesh admission reference changed.");
  const references = readChatTurnFeatureReferences(binding.references);
  const selected = references.selectedMeshCapabilities;
  if (
    !selected ||
    digest(references) !== context.referenceSha256 ||
    canonicalJsonString(selected.scope) !== canonicalJsonString(context.scope)
  ) {
    throw new Error("Mesh capabilities have no exact admission reference.");
  }
  const ids = new Set(selected.selected.map((item) => item.capabilityId));
  const entries = (await host.listCallable(context.scope.workspaceId)).filter((entry) => ids.has(entry.capabilityId));
  const schemas = await resolveMeshChatToolSchemas(host, { workspaceId: context.scope.workspaceId, entries });
  if (
    schemas.length !== ids.size ||
    schemas.some((schema) => {
      const expected = selected.selected.find((item) => item.capabilityId === schema.canonicalName);
      return (
        !expected ||
        expected.modelName !== schema.modelName ||
        expected.providerDefinitionSha256 !== digest(schema.providerDefinition) ||
        canonicalJsonString(expected.publication) !== canonicalJsonString(schema.publication)
      );
    })
  )
    throw new Error("Selected mesh publication, activation, health or schema changed.");
  await context.assertCurrent();
  return schemas;
}

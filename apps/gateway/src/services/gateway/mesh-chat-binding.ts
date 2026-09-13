import {
  canonicalJsonString,
  NotFoundError,
  type ChatTurnCapabilityProfileRecord,
  type ToolAccessEvaluateRequest,
  type ToolInvokeRequest,
} from "@goatcitadel/contracts";
import { ToolExecutionPreconditionError } from "@goatcitadel/policy-engine";
import { verifyChatTurnCapabilityCatalogBinding, verifyChatTurnCapabilityProfile,
  type AsyncStorage } from "@goatcitadel/storage";
import { resolveMeshChatToolSchemas, type MeshChatToolSchema } from "./mesh-chat-catalog.js";

const brand: unique symbol = Symbol("MeshChatTurnContext");
export interface MeshChatTurnContextHandle { readonly [brand]: true }
export interface MeshChatToolBinding { schema: MeshChatToolSchema; executionProfileSha256: string }

/** Namespace recognition only; the persisted profile and owner establish identity. */
export function isMeshChatToolName(name: string): boolean {
  return name.startsWith("mesh:") && name.length <= 273;
}
const contexts = new WeakMap<MeshChatTurnContextHandle, {
  profileId: string; profileHash: string; identity: ChatTurnCapabilityProfileRecord["identity"];
}>();

function invalidBinding(): never {
  throw new ToolExecutionPreconditionError("Mesh tool requires its exact current frozen Chat capability binding");
}

/** Internal Chat/worker composition only. A request body can never provide this handle. */
export function createMeshChatTurnContext(profile: ChatTurnCapabilityProfileRecord): MeshChatTurnContextHandle {
  verifyChatTurnCapabilityProfile(profile);
  if (!profile.identity.authActorId || !profile.identity.authActorSource) invalidBinding();
  const handle = Object.freeze({ [brand]: true as const,
    toJSON(): never { throw new Error("Mesh Chat contexts cannot be serialized"); } });
  contexts.set(handle, { profileId: profile.profileId, profileHash: profile.hashes.profileHash,
    identity: Object.freeze(structuredClone(profile.identity)) });
  return handle;
}

/**
 * Reconstruct policy mapping from the immutable profile/catalog join and the
 * current publication owner. This is admission evidence, not permission to
 * dispatch: invocation still enters the canonical policy and effect owners.
 */
export async function resolveMeshChatToolBinding(
  deps: Parameters<typeof resolveMeshChatToolSchemas>[0] & {
    storage: Pick<AsyncStorage, "chatTurnCapabilityProfiles" | "capabilityCatalogSnapshots" | "meshCapabilityPublications">;
  },
  request: ToolAccessEvaluateRequest & Partial<Pick<ToolInvokeRequest, "turnId">>,
  handle: MeshChatTurnContextHandle | undefined,
): Promise<MeshChatToolBinding | undefined> {
  if (!request.toolName.startsWith("mesh:")) return undefined;
  const context = handle ? contexts.get(handle) : undefined;
  if (!context || request.sessionId !== context.identity.sessionId ||
    request.workspaceId !== context.identity.workspaceId ||
    request.policyContext?.authActorId !== context.identity.authActorId ||
    request.policyContext?.authActorSource !== context.identity.authActorSource ||
    (request.turnId !== undefined && request.turnId !== context.identity.turnId) ||
    (request.citadelId !== undefined && request.citadelId !== context.identity.citadelId)) invalidBinding();
  let profile: ChatTurnCapabilityProfileRecord;
  try {
    profile = await deps.storage.chatTurnCapabilityProfiles.get(context.profileId);
  } catch (error) {
    if (error instanceof NotFoundError) invalidBinding();
    throw error;
  }
  if (profile.profileId !== context.profileId || profile.hashes.profileHash !== context.profileHash ||
    canonicalJsonString(profile.identity) !== canonicalJsonString(context.identity) ||
    (request.permissionProfileId !== undefined && request.permissionProfileId !== profile.governance.permission.profileId))
    invalidBinding();
  let catalog;
  try {
    verifyChatTurnCapabilityProfile(profile);
    catalog = await deps.storage.capabilityCatalogSnapshots.get(profile.catalog.snapshotId);
    verifyChatTurnCapabilityCatalogBinding(profile, catalog);
  } catch { invalidBinding(); }
  const selected = profile.selection.tools.filter((tool) => tool.canonicalName === request.toolName);
  if (selected.length !== 1 || !selected[0]!.meshPublication || selected[0]!.runtimeOwner?.kind !== "builtin") invalidBinding();
  const admitted = selected[0]!;
  const entries = catalog.callableEntries.filter((entry) => entry.capabilityId === request.toolName);
  if (entries.length !== 1) invalidBinding();
  const [schema] = await resolveMeshChatToolSchemas(deps, { workspaceId: context.identity.workspaceId, entries });
  if (!schema || schema.modelName !== admitted.modelName ||
    canonicalJsonString(schema.providerDefinition) !== canonicalJsonString(admitted.providerDefinition) ||
    canonicalJsonString(schema.publication) !== canonicalJsonString(admitted.meshPublication)) invalidBinding();
  return Object.freeze({ schema, executionProfileSha256: profile.hashes.profileHash });
}

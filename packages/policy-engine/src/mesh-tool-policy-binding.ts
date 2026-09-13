import { deriveMeshCapabilityId } from "@goatcitadel/contracts";
import type { ToolDefinition } from "./tool-registry.js";

const bindingBrand: unique symbol = Symbol("MeshToolPolicyBinding");

/** Process-local policy mapping, not publication, execution, or approval authority. */
export interface MeshToolPolicyBinding {
  readonly [bindingBrand]: true;
}

export interface MeshToolPolicyIdentity {
  readonly canonicalName: string;
  readonly policyToolName: "mesh.invoke";
  readonly nodeId: string;
  readonly kind: "tool" | "mcp_server";
  readonly localId: string;
}

/** Policy template only. There is no public generic mesh invocation tool. */
export const MESH_TOOL_POLICY_DEFINITION: Readonly<ToolDefinition> = Object.freeze({
  name: "mesh.invoke",
  category: "ops",
  riskLevel: "danger",
  requiresApproval: true,
  description: "Invoke an activated mesh capability through its governed remote execution owner.",
  pack: "core",
  readOnly: false,
  deterministic: false,
  codeModeAllowed: false,
});

const identities = new WeakMap<MeshToolPolicyBinding, MeshToolPolicyIdentity>();

export function createMeshToolPolicyBinding(
  input: Omit<MeshToolPolicyIdentity, "policyToolName">,
): MeshToolPolicyBinding {
  if ((input.kind !== "tool" && input.kind !== "mcp_server") ||
    input.canonicalName !== deriveMeshCapabilityId(input.nodeId, input.kind, input.localId)) {
    throw new Error("Invalid mesh policy mapping");
  }
  const handle = Object.freeze({
    [bindingBrand]: true as const,
    toJSON(): never { throw new Error("Mesh policy bindings cannot be serialized"); },
  });
  identities.set(handle, Object.freeze({
    canonicalName: input.canonicalName, policyToolName: "mesh.invoke",
    nodeId: input.nodeId, kind: input.kind, localId: input.localId,
  }));
  return handle;
}

export function readMeshToolPolicyBinding(
  binding: MeshToolPolicyBinding | undefined,
  canonicalName: string,
): MeshToolPolicyIdentity | undefined {
  if (binding === undefined) return undefined;
  const identity = identities.get(binding);
  if (!identity || identity.canonicalName !== canonicalName) {
    throw new Error("Missing or mismatched mesh policy binding");
  }
  return identity;
}

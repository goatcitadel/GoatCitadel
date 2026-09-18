export type MeshCapabilityInvocationServiceErrorCode =
  | "mesh_capability_invocation_not_callable"
  | "mesh_capability_invocation_input_invalid"
  | "mesh_capability_invocation_capacity_exhausted"
  | "mesh_capability_invocation_conflict"
  | "mesh_capability_invocation_not_found"
  | "mesh_capability_settlement_node_mismatch"
  | "mesh_capability_settlement_stale_generation"
  | "mesh_capability_settlement_conflict"
  | "mesh_capability_settlement_invalid"
  | "mesh_capability_progress_rejected";

const ERROR_STATUS: Readonly<Record<MeshCapabilityInvocationServiceErrorCode, number>> = Object.freeze({
  mesh_capability_invocation_not_callable: 409,
  mesh_capability_invocation_input_invalid: 400,
  mesh_capability_invocation_capacity_exhausted: 503,
  mesh_capability_invocation_conflict: 409,
  mesh_capability_invocation_not_found: 404,
  mesh_capability_settlement_node_mismatch: 403,
  mesh_capability_settlement_stale_generation: 409,
  mesh_capability_settlement_conflict: 409,
  mesh_capability_settlement_invalid: 400,
  mesh_capability_progress_rejected: 409,
});

/** Content-free typed failure; the reason code is the entire disclosure. */
export class MeshCapabilityInvocationServiceError extends Error {
  public readonly statusCode: number;

  public constructor(public readonly code: MeshCapabilityInvocationServiceErrorCode) {
    super(`Mesh capability invocation request failed: ${code}.`);
    this.name = "MeshCapabilityInvocationServiceError";
    this.statusCode = ERROR_STATUS[code];
  }
}


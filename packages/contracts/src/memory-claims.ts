/** Identity describes one property; authority always comes from its owning lifecycle. */
export interface MemoryClaimIdentity {
  subject: string;
  predicate: string;
  scope: { kind: "workspace" | "project" | "session"; id: string };
  cardinality: "scalar" | "set";
}

export interface MemoryClaim {
  identity: MemoryClaimIdentity;
  value: string;
}
export interface MemoryCorrectionTarget {
  sourceRef: string;
  expectedSourceHash: string;
}

export function normalizeMemoryClaim(claim: MemoryClaim): MemoryClaim {
  const identity = claim?.identity;
  if (
    !identity ||
    !["workspace", "project", "session"].includes(identity.scope?.kind) ||
    !["scalar", "set"].includes(identity.cardinality) ||
    typeof identity.scope.id !== "string" ||
    !identity.scope.id.trim() ||
    identity.scope.id !== identity.scope.id.trim() ||
    identity.scope.id.length > 300
  ) {
    throw new TypeError("Invalid memory claim scope or cardinality.");
  }
  const normalize = (value: string, limit: number) => {
    if (typeof value !== "string" || !value.trim() || value.length > limit)
      throw new TypeError("Invalid memory claim field.");
    return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  };
  return {
    identity: {
      subject: normalize(identity.subject, 200).toLowerCase(),
      predicate: normalize(identity.predicate, 200).toLowerCase(),
      scope: { ...identity.scope },
      cardinality: identity.cardinality,
    },
    value: normalize(claim.value, 2000),
  };
}

/** Collision-free, server-derived key. Never accept a key supplied by an API caller. */
export function memoryClaimKey(workspaceId: string, claim: MemoryClaim): string {
  if (!workspaceId?.trim() || workspaceId !== workspaceId.trim())
    throw new TypeError("A claim needs a canonical workspace.");
  const { identity } = normalizeMemoryClaim(claim);
  if (identity.scope.kind === "workspace" && identity.scope.id !== workspaceId)
    throw new TypeError("Memory claim workspace mismatch.");
  return JSON.stringify([
    1,
    workspaceId,
    identity.scope.kind,
    identity.scope.id,
    identity.subject,
    identity.predicate,
    identity.cardinality,
  ]);
}

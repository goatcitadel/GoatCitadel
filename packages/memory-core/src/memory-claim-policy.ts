import {
  memoryClaimKey,
  normalizeMemoryClaim,
  type MemoryClaim,
  type MemoryCorrectionTarget,
} from "@goatcitadel/contracts";

export interface ClaimSource {
  sourceRef: string;
  sourceHash: string;
  workspaceId: string;
  claim?: MemoryClaim;
}

export function classifyMemoryClaimChange(input: {
  incoming: { workspaceId: string; claim?: MemoryClaim; authority: string; correctionTarget?: MemoryCorrectionTarget };
  current: ClaimSource[];
}): "independent" | "duplicate" | "correction" | "ambiguous" {
  const incoming = input.incoming;
  if (!incoming.claim) return "independent";
  const claim = normalizeMemoryClaim(incoming.claim);
  const key = memoryClaimKey(incoming.workspaceId, claim);
  const matches = input.current.filter(
    (source) =>
      source.workspaceId === incoming.workspaceId &&
      source.claim &&
      memoryClaimKey(source.workspaceId, source.claim) === key,
  );
  const target = incoming.correctionTarget;
  if (target) {
    const targeted = matches.filter(
      (source) =>
        source.sourceRef === target.sourceRef &&
        source.sourceHash.length > 0 &&
        source.sourceHash === target.expectedSourceHash,
    );
    if (
      incoming.authority !== "operator" ||
      targeted.length !== 1 ||
      (claim.identity.cardinality === "scalar" && matches.length !== 1)
    )
      return "ambiguous";
    return normalizeMemoryClaim(targeted[0]!.claim!).value.toLowerCase() === claim.value.toLowerCase()
      ? "duplicate"
      : "correction";
  }
  if (matches.some((source) => normalizeMemoryClaim(source.claim!).value.toLowerCase() === claim.value.toLowerCase()))
    return "duplicate";
  if (!matches.length || claim.identity.cardinality === "set") return "independent";
  return "ambiguous";
}

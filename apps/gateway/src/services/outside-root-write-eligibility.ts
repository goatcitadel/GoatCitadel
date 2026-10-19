import type { ToolInvokeRequest } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";

export interface OutsideRootWriteEligibilityDeps {
  storage: Pick<AsyncStorage, "chatDelegationSteps">;
}

/**
 * Gateway-owned eligibility for writes outside every write root (approve-once
 * or folder grants). Only ordinary sessions qualify: delegated child sessions
 * (with or without an approved scope), A2A peers, and mesh nodes never do. A
 * failed lookup fails closed. The policy engine and executor call this at
 * evaluation and again at execution.
 */
export async function isOutsideRootWriteEligible(
  request: Pick<ToolInvokeRequest, "sessionId" | "policyContext">,
  deps: OutsideRootWriteEligibilityDeps,
): Promise<boolean> {
  const actorSource = request.policyContext?.authActorSource;
  if (actorSource === "a2a_peer" || actorSource === "mesh_node") return false;
  const sessionId = request.sessionId.trim();
  if (!sessionId) return false;
  try {
    const parents = await deps.storage.chatDelegationSteps.listParentsByChildSessionIds([sessionId]);
    return !parents.has(sessionId);
  } catch {
    return false;
  }
}

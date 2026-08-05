import type { CitadelWard, WardEffect } from "@goatcitadel/contracts";
import { DEFAULT_CITADEL_ID, evaluateWards } from "@goatcitadel/contracts";

/**
 * Citadel Ward evaluation for external-side-effect boundaries that are not
 * registry tools (integration operator actions, a2a outbound/push).
 *
 * Why not `PolicyEngine.evaluateAccess`: the engine denies unregistered tool
 * names as `unknown_tool` BEFORE ward evaluation, and these boundary names are
 * deliberately not catalog tools. This gate reuses the engine's exact ward
 * semantics (`evaluateWards`, deny-wins) against the same citadel_wards rows,
 * resolved through the same workspace→citadel chain the tool-invoke path uses.
 *
 * Enforcement contract for callers (the runner only enforces
 * `require_dry_run`): `deny` and `require_approval` MUST be blocked by the
 * caller before the boundary; `require_dry_run` is threaded to
 * `runIdempotentExternalSideEffect` as `wardEffect` (it refuses pre-boundary);
 * `redact`/`route_local` are not meaningful at these boundaries and pass
 * through (callers may record them).
 */
export interface CitadelWardGateStorage {
  workspaces?: {
    find(workspaceId: string): { citadelId?: string } | undefined | Promise<{ citadelId?: string } | undefined>;
  };
  citadels?: { listWards(citadelId: string): CitadelWard[] | Promise<CitadelWard[]> };
}

export interface CitadelWardGateResult {
  /** `undefined` when no ward matched or the matching ward allows. */
  effect: WardEffect | undefined;
  /** The citadel the action was evaluated against (personal when unresolvable). */
  citadelId: string;
}

export async function resolveWardEffectForExternalAction(input: {
  storage: CitadelWardGateStorage;
  workspaceId?: string;
  action: string;
}): Promise<CitadelWardGateResult> {
  const workspaceId = input.workspaceId?.trim();
  const citadelId =
    (workspaceId ? (await input.storage.workspaces?.find(workspaceId))?.citadelId : undefined) ?? DEFAULT_CITADEL_ID;
  const wards = (await input.storage.citadels?.listWards(citadelId)) ?? [];
  if (wards.length === 0) {
    return { effect: undefined, citadelId };
  }
  const effect = evaluateWards(wards, input.action);
  // Mirror the engine: a ward that resolves to "allow" (or no match) imposes
  // nothing on the caller.
  return { effect: effect === "allow" ? undefined : effect, citadelId };
}

/**
 * Ward action name for an integration operator action. catalogIds are the
 * operator-visible canonical identifiers (e.g. "automation.gmail"), so wards
 * like `integration.automation.gmail.*` or `integration.*` match meaningfully.
 * The local bridge uses the same name as the direct transport on purpose —
 * wards gate the ACTION, not the transport.
 */
export function buildIntegrationWardAction(catalogId: string, actionId: string): string {
  return `integration.${catalogId}.${actionId}`;
}

/**
 * Ward action name for an a2a outbound boundary. The method segment is
 * included from day one ("message/send" → "message.send") — appending
 * segments later would silently break anchored exact-match wards.
 */
export function buildA2AOutboundWardAction(transport: "jsonrpc" | "grpc" | "push", method?: string): string {
  if (transport === "push") {
    return "a2a.outbound.push";
  }
  const methodSegment = method?.trim().replaceAll("/", ".");
  return methodSegment ? `a2a.outbound.${transport}.${methodSegment}` : `a2a.outbound.${transport}`;
}

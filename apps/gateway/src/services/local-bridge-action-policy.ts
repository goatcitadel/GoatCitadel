import type { IntegrationOperatorAction } from "@goatcitadel/contracts";

const LOCAL_BRIDGE_READ_ONLY_CAPABILITIES = new Set(["read", "tray"]);

export function isLocalBridgeExternalSideEffectAction(action: IntegrationOperatorAction): boolean {
  return !LOCAL_BRIDGE_READ_ONLY_CAPABILITIES.has(action.capability.trim().toLowerCase());
}

export function buildLocalBridgeActionTargets(bridgeUrl: string, actionRoute?: string): [string, string] {
  const canonicalTarget = appendBridgePath(bridgeUrl, "/v1/integrations/actions");
  const legacyTarget = appendBridgePath(bridgeUrl, "/api/v1/integrations/actions");
  return actionRoute === "api_v1" ? [legacyTarget, canonicalTarget] : [canonicalTarget, legacyTarget];
}

function appendBridgePath(baseUrl: string, suffix: string): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${normalizedBase}${suffix}`;
}

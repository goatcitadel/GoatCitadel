import type { QueryClient } from "@tanstack/react-query";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";

type Scope = { installation: string; workspaceId: string; accessRevision: number; generation: number };
// Presentation lifecycle metadata only. Source observations and denials belong to QueryClient records.
const scopes = new WeakMap<QueryClient, Scope>();

/** All current health consumers share one token; returning to a workspace revalidates access once. */
export function healthQueryScope(client: QueryClient, workspaceId: string, accessRevision: number, active = true) {
  const installation = getGatewayApiBaseUrl();
  let scope = scopes.get(client);
  if (active && (!scope || scope.installation !== installation || scope.workspaceId !== workspaceId || scope.accessRevision !== accessRevision)) {
    scope = { installation, workspaceId, accessRevision, generation: scope ? scope.generation + 1 : 0 };
    scopes.set(client, scope);
  }
  return [installation, accessRevision, scope?.generation ?? 0] as const;
}

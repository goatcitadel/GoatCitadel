import {
  getGatewayAccessRevision,
  getGatewayCallerScope,
  getGatewayCallerScopeRevision,
} from "@goatcitadel/mission-control-shared/api/access-scope";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import type { ChatSessionDataInput } from "./chat-session-data-bootstrap";
export function chatSidebarScopeKey(
  input: Pick<ChatSessionDataInput, "workspaceId" | "viewIdentity" | "surfaceMode" | "historyView" | "searchQuery">,
) {
  return JSON.stringify([
    input.workspaceId,
    input.viewIdentity,
    input.surfaceMode,
    input.historyView,
    input.searchQuery,
    getGatewayAccessRevision(),
    getGatewayCallerScope(),
    getGatewayCallerScopeRevision(),
    getGatewayApiBaseUrl(),
  ]);
}
